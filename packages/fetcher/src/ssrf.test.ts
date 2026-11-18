import { lookup as dnsLookup } from "node:dns";
import { EventEmitter } from "node:events";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPage } from "./index.js";

vi.mock("node:dns", () => ({ lookup: vi.fn() }));
vi.mock("node:http", () => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: vi.fn() }));

type Answer = { address: string; family: number };
type LookupCallback = (error: Error | null, address: string, family: number) => void;

function respondDns(answers: Answer[]): void {
  vi.mocked(dnsLookup).mockImplementation(((...args: unknown[]) => {
    const callback = args[2] as (error: Error | null, result: Answer[]) => void;
    callback(null, answers);
  }) as typeof dnsLookup);
}

function setupTransport(location: string | null, connected: string[]): void {
  vi.mocked(httpRequest).mockImplementation(((...args: unknown[]) => {
    const target = args[0] as URL;
    const options = args[1] as {
      lookup: (hostname: string, options: { family: number; hints: number }, cb: LookupCallback) => void;
    };
    const onResponse = args[2] as (response: IncomingMessage) => void;
    const request = new EventEmitter() as EventEmitter & { end: () => void };
    request.end = () => {
      options.lookup(target.hostname, { family: 0, hints: 0 }, (error, address) => {
        if (error) {
          queueMicrotask(() => request.emit("error", error));
          return;
        }
        connected.push(address);
        const response = Readable.from(location === null ? ["hello"] : []) as IncomingMessage;
        response.statusCode = location === null ? 200 : 302;
        response.headers = location === null
          ? { "content-type": "text/html" }
          : { location };
        queueMicrotask(() => onResponse(response));
      });
    };
    return request as unknown as ReturnType<typeof httpRequest>;
  }) as typeof httpRequest);
}

describe("SSRF enforcement before connection", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    "http://127.0.0.1/",
    "http://2130706433/", // Decimal IPv4 form normalized by WHATWG URL
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd00:ec2::254]/",
    "http://100.100.100.200/",
    "https://metadata.google.internal/",
    "http://metadata/",
    "http://service.internal/",
    "http://10.0.0.1:80/",
  ])("blocks %s without attempting a network request", async (target) => {
    await expect(fetchPage(target)).rejects.toMatchObject({ code: "BLOCKED_ADDRESS" });
    expect(httpRequest).not.toHaveBeenCalled();
    expect(httpsRequest).not.toHaveBeenCalled();
    expect(dnsLookup).not.toHaveBeenCalled();
  });

  it("rejects a hostname with mixed public and private DNS records before connecting", async () => {
    respondDns([
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    const connected: string[] = [];
    setupTransport(null, connected);

    await expect(fetchPage("http://example.com/")).rejects.toMatchObject({
      code: "BLOCKED_ADDRESS",
    });
    expect(connected).toEqual([]);
    expect(dnsLookup).toHaveBeenCalledTimes(1);
  });

  it("uses a pinned public DNS address rather than re-resolving after a check", async () => {
    respondDns([{ address: "8.8.8.8", family: 4 }]);
    const connected: string[] = [];
    setupTransport(null, connected);

    const response = await fetchPage("http://example.com/");
    expect(response.statusCode).toBe(200);
    expect(response.html).toBe("hello");
    expect(connected).toEqual(["8.8.8.8"]);
    expect(dnsLookup).toHaveBeenCalledTimes(1);
  });

  it("rejects a redirect into a metadata address without opening the next connection", async () => {
    respondDns([{ address: "8.8.8.8", family: 4 }]);
    const connected: string[] = [];
    setupTransport("http://169.254.169.254/latest/meta-data", connected);

    await expect(fetchPage("http://example.com/", { maxRedirects: 3 }))
      .rejects.toMatchObject({ code: "BLOCKED_ADDRESS" });
    expect(httpRequest).toHaveBeenCalledTimes(1);
    expect(connected).toEqual(["8.8.8.8"]);
  });

  it("rejects a redirect where the next DNS answer changes to private", async () => {
    let count = 0;
    vi.mocked(dnsLookup).mockImplementation(((...args: unknown[]) => {
      const callback = args[2] as (error: Error | null, result: Answer[]) => void;
      count += 1;
      callback(null, [{
        address: count === 1 ? "8.8.8.8" : "192.168.1.10",
        family: 4,
      }]);
    }) as typeof dnsLookup);
    const connected: string[] = [];
    setupTransport("http://other.com/next", connected);

    await expect(fetchPage("http://example.com/", { maxRedirects: 3 }))
      .rejects.toMatchObject({ code: "BLOCKED_ADDRESS" });
    expect(httpRequest).toHaveBeenCalledTimes(2);
    expect(connected).toEqual(["8.8.8.8"]);
    expect(dnsLookup).toHaveBeenCalledTimes(2);
  });

  it("enforces the redirect limit on a public redirect loop", async () => {
    respondDns([{ address: "8.8.8.8", family: 4 }]);
    const connected: string[] = [];
    setupTransport("/loop", connected);

    await expect(fetchPage("http://example.com/", { maxRedirects: 1 }))
      .rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });
    expect(httpRequest).toHaveBeenCalledTimes(2);
  });

  it("honors an already-cancelled signal without starting a request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(fetchPage("http://example.com/", { signal: controller.signal }))
      .rejects.toMatchObject({ code: "ABORTED" });
    expect(httpRequest).not.toHaveBeenCalled();
  });
});
