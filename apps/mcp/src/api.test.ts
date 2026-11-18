import { describe, expect, it, vi } from "vitest";
import { DoxRestClient, parseApiOrigin } from "./api.js";

function mockResponse(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("MCP REST proxy security", () => {
  it.each([
    "http://192.168.1.1:3000",
    "http://example.com",
    "file:///etc/passwd",
    "http://127.0.0.1:3000/admin",
    "http://127.0.0.1:3000/?url=bad",
    "https://user:pass@example.com",
  ])("rejects untrusted base URL %s", (url) => {
    expect(() => parseApiOrigin(url)).toThrow(TypeError);
  });

  it("supports loopback HTTP and secure HTTPS origins", () => {
    expect(parseApiOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(parseApiOrigin("https://my-scraper.example")).toBe("https://my-scraper.example");
    expect(() => new DoxRestClient({ apiKey: "" })).toThrow(TypeError);
  });

  it("sends token only to configured REST origin and never follows redirects", async () => {
    const transport = vi.fn(async () => mockResponse({
      success: true, data: { hello: "world" },
    }));
    const client = new DoxRestClient({
      apiKey: "never-leak-secret",
      transport: transport as typeof fetch,
    });
    expect(await client.post("/v1/scrape", { url: "https://example.com" }))
      .toEqual({ hello: "world" });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:3000/v1/scrape");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      headers: {
        authorization: "Bearer never-leak-secret",
        "content-type": "application/json",
      },
    });
    await expect(client.get("https://other.example")).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("does not follow an API redirect to another destination", async () => {
    const transport = vi.fn(async () => new Response(null, {
      status: 302, headers: { location: "http://127.0.0.1:8000/stolen" },
    }));
    const client = new DoxRestClient({
      apiKey: "key", transport: transport as typeof fetch,
    });
    await expect(client.get("/v1/crawl/abc")).rejects.toMatchObject({
      code: "API_REDIRECT_REJECTED",
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("maps 401 and 403 REST responses to MCP errors", async () => {
    const transport = vi.fn(async () => mockResponse({
      success: false, error: { code: "ORIGIN_NOT_ALLOWED", message: "Target blocked" },
    }, 403));
    const client = new DoxRestClient({
      apiKey: "key", transport: transport as typeof fetch,
    });
    await expect(client.post("/v1/crawl", { url: "https://example.com" }))
      .rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED", httpStatus: 403 });
  });

  it("rejects a response body exceeding the configured byte cap", async () => {
    const transport = vi.fn(async () => mockResponse({
      success: true, data: "x".repeat(3000),
    }));
    const client = new DoxRestClient({
      apiKey: "key",
      maxResponseBytes: 1024,
      transport: transport as typeof fetch,
    });
    await expect(client.get("/v1/crawl/abc")).rejects.toMatchObject({
      code: "API_RESPONSE_TOO_LARGE",
    });
  });

  it("refuses malformed/non-JSON success payloads", async () => {
    const transport = vi.fn(async () => new Response("not json", { status: 200 }));
    const client = new DoxRestClient({
      apiKey: "key", transport: transport as typeof fetch,
    });
    await expect(client.get("/v1/crawl/abc")).rejects.toMatchObject({
      code: "API_INVALID_RESPONSE",
    });
  });
});
