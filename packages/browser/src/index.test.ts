import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page, type Route, type WebSocketRoute } from "playwright-core";
import { BrowserRenderer } from "./index.js";

vi.mock("playwright-core", () => ({ chromium: { launch: vi.fn() } }));

const URL = "https://example.com/dynamic";
const SOURCE_HTML = `<!doctype html><html><body><main><p id="target">Loading</p>
<script>document.getElementById("target").textContent = "Rendered by JavaScript";</script>
</main></body></html>`;

type RouteHandler = (route: Route) => Promise<void> | void;
type SocketHandler = (socket: WebSocketRoute) => Promise<void> | void;

function makeFakeBrowser(outputHtml: string = SOURCE_HTML) {
  let handler: RouteHandler | undefined;
  let socketHandler: SocketHandler | undefined;
  let actualUrl = URL;
  const fulfilled: unknown[] = [];
  const aborted: string[] = [];
  const closedSockets: string[] = [];

  const fakePage = {
    goto: vi.fn(async (url: string) => {
      if (!handler) throw new Error("HTTP network interception was not installed");
      const route = {
        request: () => ({
          isNavigationRequest: () => true,
          resourceType: () => "document",
          method: () => "GET",
          url: () => url,
        }),
        fulfill: async (value: unknown) => { fulfilled.push(value); },
        abort: async (code: string) => { aborted.push(code); },
      } as unknown as Route;
      await handler(route);
      return null;
    }),
    waitForTimeout: vi.fn(async () => {}),
    content: vi.fn(async () => outputHtml),
    url: vi.fn(() => actualUrl),
    close: vi.fn(async () => {}),
  } as unknown as Page;
  const fakeContext = {
    route: vi.fn(async (_pattern: string, callback: RouteHandler) => { handler = callback; }),
    routeWebSocket: vi.fn(async (_pattern: string, callback: SocketHandler) => { socketHandler = callback; }),
    newPage: vi.fn(async () => fakePage),
    close: vi.fn(async () => {}),
  } as unknown as BrowserContext;
  const fakeBrowser = {
    newContext: vi.fn(async () => fakeContext),
    close: vi.fn(async () => {}),
  } as unknown as Browser;

  vi.mocked(chromium.launch).mockResolvedValue(fakeBrowser);

  return {
    browser: fakeBrowser,
    context: fakeContext,
    page: fakePage,
    fulfilled, aborted, closedSockets,
    getRoute: () => handler,
    getSocketRoute: () => socketHandler,
    setUrl: (value: string) => { actualUrl = value; },
  };
}

describe("BrowserRenderer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fails closed without a configured Chromium executable", async () => {
    const renderer = new BrowserRenderer();
    await expect(renderer.render({ url: URL, html: SOURCE_HTML }))
      .rejects.toMatchObject({ code: "BROWSER_DISABLED" });
    expect(chromium.launch).not.toHaveBeenCalled();
  });

  it("intercepts the document, blocks extra network requests and always closes resources", async () => {
    const fake = makeFakeBrowser('<html><body><h1>Rendered by JavaScript</h1></body></html>');
    const renderer = new BrowserRenderer({ executablePath: "/usr/bin/chromium" });
    const result = await renderer.render({ url: URL, html: SOURCE_HTML, settleMs: 0 });

    expect(result.html).toContain("Rendered by JavaScript");
    expect(result.url).toBe(URL);
    expect(renderer.isBusy()).toBe(false);
    expect(vi.mocked(chromium.launch)).toHaveBeenCalledWith(expect.objectContaining({
      executablePath: "/usr/bin/chromium",
      chromiumSandbox: true,
      headless: true,
    }));
    expect(vi.mocked(fake.browser.newContext)).toHaveBeenCalledWith(expect.objectContaining({
      serviceWorkers: "block",
      acceptDownloads: false,
      bypassCSP: false,
    }));
    expect(fake.fulfilled).toEqual([expect.objectContaining({
      status: 200, contentType: "text/html; charset=utf-8", body: SOURCE_HTML,
    })]);
    expect(vi.mocked(fake.context.route)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fake.context.routeWebSocket)).toHaveBeenCalledTimes(1);

    const abort = vi.fn(async () => {});
    await fake.getRoute()!({
      request: () => ({
        isNavigationRequest: () => false,
        resourceType: () => "fetch",
        method: () => "GET",
        url: () => "http://169.254.169.254/latest/meta-data",
      }),
      abort,
    } as unknown as Route);
    expect(abort).toHaveBeenCalledWith("blockedbyclient");

    const close = vi.fn();
    fake.getSocketRoute()!({ close } as unknown as WebSocketRoute);
    expect(close).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fake.page.close)).toHaveBeenCalled();
    expect(vi.mocked(fake.context.close)).toHaveBeenCalled();
    expect(vi.mocked(fake.browser.close)).toHaveBeenCalled();
  });

  it("allows only one browser job at a time and releases slot after cancellation", async () => {
    const fake = makeFakeBrowser();
    let started!: () => void;
    const isStarted = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(fake.page.goto).mockImplementation(async () => {
      started();
      return new Promise<never>(() => {});
    });
    const controller = new AbortController();
    const renderer = new BrowserRenderer({ executablePath: "/usr/bin/chromium" });
    const first = renderer.render({ url: URL, html: SOURCE_HTML, signal: controller.signal });
    await isStarted;

    await expect(renderer.render({ url: URL, html: SOURCE_HTML }))
      .rejects.toMatchObject({ code: "BROWSER_BUSY" });
    expect(chromium.launch).toHaveBeenCalledTimes(1);
    controller.abort();

    await expect(first).rejects.toMatchObject({ code: "BROWSER_ABORTED" });
    expect(renderer.isBusy()).toBe(false);
    expect(vi.mocked(fake.browser.close)).toHaveBeenCalled();
  });

  it("rejects oversized input and output HTML", async () => {
    const renderer = new BrowserRenderer({ executablePath: "/usr/bin/chromium" });
    await expect(renderer.render({ url: URL, html: "x".repeat(2048), maxHtmlBytes: 1024 }))
      .rejects.toMatchObject({ code: "BROWSER_TOO_LARGE" });
    expect(chromium.launch).not.toHaveBeenCalled();

    const fake = makeFakeBrowser("y".repeat(2048));
    await expect(renderer.render({ url: URL, html: "<p>okay</p>", maxHtmlBytes: 1024 }))
      .rejects.toMatchObject({ code: "BROWSER_TOO_LARGE" });
    expect(vi.mocked(fake.browser.close)).toHaveBeenCalled();
  });

  it("rejects a page navigation outside its prefetched URL", async () => {
    const fake = makeFakeBrowser();
    fake.setUrl("https://other.example/");
    const renderer = new BrowserRenderer({ executablePath: "/usr/bin/chromium" });
    await expect(renderer.render({ url: URL, html: SOURCE_HTML }))
      .rejects.toMatchObject({ code: "BROWSER_RENDER_FAILED" });
    expect(vi.mocked(fake.browser.close)).toHaveBeenCalled();
  });

  it("rejects local or invalid URL and invalid timeout settings before startup", async () => {
    const renderer = new BrowserRenderer({ executablePath: "/usr/bin/chromium" });
    await expect(renderer.render({ url: "http://127.0.0.1/", html: SOURCE_HTML }))
      .rejects.toThrow();
    await expect(renderer.render({ url: URL, html: SOURCE_HTML, totalTimeoutMs: 60 }))
      .rejects.toThrow(RangeError);
    await expect(renderer.render({
      url: URL, html: SOURCE_HTML, totalTimeoutMs: 2000, navigationTimeoutMs: 3000,
    })).rejects.toThrow(RangeError);
    expect(chromium.launch).not.toHaveBeenCalled();
  });
});
