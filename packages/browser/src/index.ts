import { validateTargetUrl } from "@dox-scraper/fetcher";
import type { Browser, BrowserContext, Page } from "playwright-core";

export type BrowserRenderErrorCode =
  | "BROWSER_DISABLED" | "BROWSER_BUSY" | "BROWSER_TIMEOUT"
  | "BROWSER_ABORTED" | "BROWSER_TOO_LARGE" | "BROWSER_RENDER_FAILED";

export class BrowserRenderError extends Error {
  constructor(public readonly code: BrowserRenderErrorCode, message: string) {
    super(message);
    this.name = "BrowserRenderError";
  }
}

export interface BrowserRendererOptions {
  /** Path to an existing Chromium executable; nothing is downloaded. */
  executablePath?: string;
}

export interface BrowserRenderInput {
  /** Already retrieved via the safe HTTP fetcher, not loaded by Chromium. */
  html: string;
  /** Final HTTP URL corresponding to this HTML. */
  url: string;
  /** Total deadline including startup, navigation, JavaScript and cleanup. */
  totalTimeoutMs?: number;
  /** Maximum time allowed to navigate to the intercepted document. */
  navigationTimeoutMs?: number;
  /** Delay after DOMContentLoaded to allow simple client-side rendering. */
  settleMs?: number;
  /** Bounds both input and browser-generated HTML. */
  maxHtmlBytes?: number;
  signal?: AbortSignal;
}

export interface BrowserRenderResult {
  url: string;
  html: string;
  renderedAt: string;
}

/**
 * Interrupt a pending Playwright operation when the total deadline expires.
 * The caller closes the context/browser on abort; a late launch is also
 * closed to prevent orphaned Chromium processes.
 */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function bounded(value: number, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(label + " must be between " + min + " and " + max);
  }
  return value;
}

/**
 * A single-concurrency Playwright renderer. It never invokes Playwright's
 * route.continue(), route.fetch(), or other direct-network APIs.
 *
 * The navigation HTML must already have been fetched by the protected
 * Node.js HTTP fetcher. All other resource requests and WebSockets are
 * blocked, and service workers are disabled. As an additional defense,
 * deploy Chromium in a network-isolated container with egress firewall
 * rules: browser-level routing alone is NOT a security boundary.
 *
 * This MVP renders pages relying on inline JavaScript. External JS,
 * stylesheets, images, XHR and fetch calls are deliberately unavailable
 * until a permission-gated, SSRF-safe resource proxy is implemented.
 */
export class BrowserRenderer {
  private active = false;
  private readonly executablePath: string;

  constructor(options: BrowserRendererOptions = {}) {
    this.executablePath = options.executablePath?.trim() ?? "";
  }

  isBusy(): boolean {
    return this.active;
  }

  async render(input: BrowserRenderInput): Promise<BrowserRenderResult> {
    if (!this.executablePath) {
      throw new BrowserRenderError("BROWSER_DISABLED", "Chromium executable is not configured");
    }
    if (this.active) {
      throw new BrowserRenderError("BROWSER_BUSY", "The single Chromium rendering slot is occupied");
    }

    const target = validateTargetUrl(input.url);
    const totalTimeoutMs = bounded(input.totalTimeoutMs ?? 15000, "totalTimeoutMs", 1000, 30000);
    const navigationTimeoutMs = bounded(
      input.navigationTimeoutMs ?? 10000, "navigationTimeoutMs", 1000, totalTimeoutMs,
    );
    const settleMs = bounded(input.settleMs ?? 400, "settleMs", 0, 2000);
    const maxHtmlBytes = bounded(input.maxHtmlBytes ?? 2 * 1024 * 1024, "maxHtmlBytes", 1024, 2 * 1024 * 1024);

    if (Buffer.byteLength(input.html, "utf8") > maxHtmlBytes) {
      throw new BrowserRenderError("BROWSER_TOO_LARGE", "Prefetched HTML exceeds the renderer limit");
    }
    if (input.signal?.aborted) {
      throw new BrowserRenderError("BROWSER_ABORTED", "Browser render cancelled");
    }

    this.active = true;
    const deadline = AbortSignal.timeout(totalTimeoutMs);
    const signal = input.signal
      ? AbortSignal.any([input.signal, deadline])
      : deadline;
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    let opened = false;
    const closeOnAbort = () => {
      // Trigger cleanup even while Playwright is waiting for navigation.
      if (page) void page.close().catch(() => {});
      if (context) void context.close().catch(() => {});
      if (browser) void browser.close().catch(() => {});
    };
    signal.addEventListener("abort", closeOnAbort, { once: true });

    try {
      // Lazy load: no Chromium binaries are installed or started on HTTP-only
      // requests. chromiumSandbox is intentionally true (no --no-sandbox).
      const { chromium } = await import("playwright-core");
      const launching = chromium.launch({
        executablePath: this.executablePath,
        headless: true,
        chromiumSandbox: true,
        args: [
          "--disable-background-networking",
          "--disable-extensions",
          "--disable-sync",
          "--no-first-run",
        ],
      });
      // Close a late browser startup that resolves after deadline.
      launching.then((late) => {
        if (signal.aborted) void late.close().catch(() => {});
      }).catch(() => {});
      browser = await abortable(launching, signal);
      context = await abortable(browser.newContext({
        javaScriptEnabled: true,
        serviceWorkers: "block",
        acceptDownloads: false,
        ignoreHTTPSErrors: false,
        bypassCSP: false,
        viewport: { width: 1000, height: 720 },
      }), signal);

      // Route BEFORE opening the first page. Never continue to the real URL.
      // Exactly one main document may be fulfilled from validated HTML.
      await context.route("**/*", async (route) => {
        const request = route.request();
        if (!opened && request.isNavigationRequest() &&
            request.resourceType() === "document" &&
            request.method() === "GET" && request.url() === target.href) {
          opened = true;
          await route.fulfill({
            status: 200,
            contentType: "text/html; charset=utf-8",
            body: input.html,
            headers: { "cache-control": "no-store" },
          });
          return;
        }
        await route.abort("blockedbyclient");
      });

      // Network routing does not intercept WebSocket connections; block
      // those separately. Service workers are disabled in this context.
      await context.routeWebSocket("**/*", (socket) => { socket.close(); });
      page = await abortable(context.newPage(), signal);
      await abortable(page.goto(target.href, {
        waitUntil: "domcontentloaded",
        timeout: navigationTimeoutMs,
      }), signal);
      await abortable(page.waitForTimeout(settleMs), signal);

      if (page.url() !== target.href) {
        throw new BrowserRenderError("BROWSER_RENDER_FAILED", "Browser navigated outside the prefetched document");
      }
      const html = await abortable(page.content(), signal);
      if (Buffer.byteLength(html, "utf8") > maxHtmlBytes) {
        throw new BrowserRenderError("BROWSER_TOO_LARGE", "Rendered HTML exceeds the maximum output size");
      }
      return { html, url: target.href, renderedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof BrowserRenderError) throw error;
      if (signal.aborted) {
        throw new BrowserRenderError(
          input.signal?.aborted ? "BROWSER_ABORTED" : "BROWSER_TIMEOUT",
          "Chromium render was cancelled or exceeded its time budget",
        );
      }
      throw new BrowserRenderError(
        "BROWSER_RENDER_FAILED",
        error instanceof Error ? error.message : "Chromium failed to render the page",
      );
    } finally {
      signal.removeEventListener("abort", closeOnAbort);
      // Cleanup must be bounded, including uncooperative worker processes.
      await Promise.race([
        (async () => {
          await page?.close().catch(() => {});
          await context?.close().catch(() => {});
          await browser?.close().catch(() => {});
        })(),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
      this.active = false;
    }
  }
}
