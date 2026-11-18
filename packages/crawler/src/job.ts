import { randomUUID } from "node:crypto";
import { validateTargetUrl } from "@dox-scraper/fetcher";
import { discoverSameOriginLinks } from "./links.js";

export type CrawlJobState = "queued" | "running" | "completed" | "failed" | "cancelled";
export type CrawlPageState = "queued" | "active" | "completed" | "failed" | "skipped" | "cancelled";

export interface CrawlPageRecord {
  url: string;
  depth: number;
  state: CrawlPageState;
  statusCode?: number;
  discoveredLinks?: number;
  error?: string;
}

export interface CrawlSnapshot {
  id: string;
  seedUrl: string;
  allowedOrigin: string;
  state: CrawlJobState;
  startedAt: string | null;
  finishedAt: string | null;
  maxPages: number;
  maxDepth: number;
  attempted: number;
  completed: number;
  failed: number;
  skipped: number;
  cancelled: number;
  queued: number;
  active: number;
  discovered: number;
  error: string | null;
  pages: CrawlPageRecord[];
}

export interface CrawlLoadedPage {
  /** Actual response URL; automatic redirects MUST be disabled in the adapter. */
  finalUrl: string;
  statusCode: number;
  contentType: string | null;
  html: string;
}

export interface CrawlRequestContext {
  signal: AbortSignal;
  maxRedirects: 0;
  maxBytes: number;
  timeoutMs: number;
}

/**
 * All network and authorization decisions are injected. A caller MUST provide
 * robots.txt/site-permission checking, per-origin request pacing, and an
 * SSRF-safe HTTP loader. No default network adapter is supplied.
 */
export interface CrawlJobOptions {
  seedUrl: string;
  /** When set, must be the exact same origin as seedUrl. */
  allowedOrigin?: string;
  maxPages?: number;
  maxDepth?: number;
  maxDiscovered?: number;
  maxHtmlBytes?: number;
  requestTimeoutMs?: number;
  /** Check current URL against robots.txt and site permissions. */
  canFetch: (url: string, signal: AbortSignal) => Promise<boolean>;
  /** Wait until a per-origin request is allowed; must honor AbortSignal. */
  acquirePermit: (url: string, signal: AbortSignal) => Promise<void>;
  /** Fetch a single page with NO redirects; must honor AbortSignal. */
  loadPage: (url: string, context: CrawlRequestContext) => Promise<CrawlLoadedPage>;
  /** Process/store a page; HTML is never retained in the job snapshot. */
  onPage?: (page: CrawlLoadedPage & { url: string; depth: number }, signal: AbortSignal) => Promise<void>;
}

function boundedInteger(value: number, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(label + " must be an integer from " + min + " to " + max);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown crawl error";
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Request aborted"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Request aborted"));
    const done = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { done(); resolve(value); },
      (error: unknown) => { done(); reject(error); },
    );
  });
}

/**
 * In-memory, sequential breadth-first crawl job. It cannot access the network
 * on its own, and cannot be restarted after completion or cancellation.
 *
 * No persistence or API endpoints are included; those are separate roadmap
 * items. All state counters reflect individual queued URL records.
 */
export class CrawlJob {
  readonly id = randomUUID();
  readonly seedUrl: string;
  readonly allowedOrigin: string;
  readonly maxPages: number;
  readonly maxDepth: number;

  private readonly maxDiscovered: number;
  private readonly maxHtmlBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly options: CrawlJobOptions;
  private readonly controller = new AbortController();
  private readonly records: CrawlPageRecord[];
  private readonly seen: Set<string>;
  private readonly queue: number[] = [0];
  private queueHead = 0;
  private attemptCount = 0;
  private state: CrawlJobState = "queued";
  private startedAt: string | null = null;
  private finishedAt: string | null = null;
  private error: string | null = null;
  private work: Promise<CrawlSnapshot> | null = null;

  constructor(options: CrawlJobOptions) {
    if (typeof options.canFetch !== "function" ||
        typeof options.acquirePermit !== "function" ||
        typeof options.loadPage !== "function") {
      throw new TypeError("A crawl requires canFetch, acquirePermit and loadPage policies");
    }

    const seed = validateTargetUrl(options.seedUrl);
    const origin = validateTargetUrl(options.allowedOrigin ?? seed.href).origin;
    if (origin !== seed.origin) {
      throw new RangeError("allowedOrigin must match the seed URL's exact origin");
    }

    this.seedUrl = seed.href;
    this.allowedOrigin = origin;
    this.maxPages = boundedInteger(options.maxPages ?? 20, "maxPages", 1, 100);
    this.maxDepth = boundedInteger(options.maxDepth ?? 2, "maxDepth", 0, 8);
    this.maxDiscovered = boundedInteger(options.maxDiscovered ?? 500, "maxDiscovered", 1, 5000);
    this.maxHtmlBytes = boundedInteger(options.maxHtmlBytes ?? 1024 * 1024, "maxHtmlBytes", 1024, 2 * 1024 * 1024);
    this.requestTimeoutMs = boundedInteger(options.requestTimeoutMs ?? 15_000, "requestTimeoutMs", 1000, 30_000);
    this.options = options;
    this.records = [{ url: this.seedUrl, depth: 0, state: "queued" }];
    this.seen = new Set([this.seedUrl]);
  }

  snapshot(): CrawlSnapshot {
    const counts = {
      completed: 0, failed: 0, skipped: 0, cancelled: 0, queued: 0, active: 0,
    };
    for (const record of this.records) counts[record.state] += 1;

    return {
      id: this.id,
      seedUrl: this.seedUrl,
      allowedOrigin: this.allowedOrigin,
      state: this.state,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      maxPages: this.maxPages,
      maxDepth: this.maxDepth,
      attempted: this.attemptCount,
      ...counts,
      discovered: this.records.length,
      error: this.error,
      pages: this.records.map((item) => ({ ...item })),
    };
  }

  cancel(): void {
    if (this.state === "completed" || this.state === "failed" || this.state === "cancelled") return;
    this.controller.abort(new Error("Crawl cancelled"));
    this.state = "cancelled";
    if (!this.finishedAt) this.finishedAt = new Date().toISOString();
    this.finishPending("cancelled", "CANCELLED");
  }

  start(): Promise<CrawlSnapshot> {
    if (this.work) return this.work;
    if (this.state !== "queued") return Promise.resolve(this.snapshot());
    this.state = "running";
    this.startedAt = new Date().toISOString();
    this.work = this.run();
    return this.work;
  }

  private finishPending(state: "cancelled" | "skipped", reason: string): void {
    for (const item of this.records) {
      if (item.state === "queued") {
        item.state = state;
        item.error = reason;
      }
    }
  }

  private enqueue(url: string, depth: number): boolean {
    if (this.seen.has(url) || this.seen.size >= this.maxDiscovered) return false;
    this.seen.add(url);
    this.records.push({ url, depth, state: "queued" });
    this.queue.push(this.records.length - 1);
    return true;
  }

  private async run(): Promise<CrawlSnapshot> {
    while (this.queueHead < this.queue.length && this.attemptCount < this.maxPages &&
           !this.controller.signal.aborted) {
      const index = this.queue[this.queueHead++];
      if (index === undefined) break;
      const item = this.records[index];
      if (!item || item.state !== "queued") continue;

      item.state = "active";
      this.attemptCount += 1;
      const timeout = AbortSignal.timeout(this.requestTimeoutMs);
      const signal = AbortSignal.any([this.controller.signal, timeout]);

      // Policy failures fail the entire crawl closed; a denied URL is skipped.
      let allowed: boolean;
      try {
        allowed = await waitFor(this.options.canFetch(item.url, signal), signal);
        if (allowed) await waitFor(this.options.acquirePermit(item.url, signal), signal);
      } catch (error) {
        if (this.controller.signal.aborted) {
          item.state = "cancelled";
          item.error = "CANCELLED";
        } else {
          item.state = "failed";
          item.error = errorMessage(error);
          this.error = "Crawl policy failed: " + item.error;
          this.state = "failed";
        }
        break;
      }
      if (!allowed) {
        item.state = "skipped";
        item.error = "NOT_PERMITTED";
        continue;
      }
      if (this.controller.signal.aborted) {
        item.state = "cancelled";
        item.error = "CANCELLED";
        break;
      }

      try {
        const response = await waitFor(
          this.options.loadPage(item.url, {
            signal,
            maxRedirects: 0,
            maxBytes: this.maxHtmlBytes,
            timeoutMs: this.requestTimeoutMs,
          }),
          signal,
        );
        if (this.controller.signal.aborted) {
          item.state = "cancelled";
          item.error = "CANCELLED";
          break;
        }

        const final = validateTargetUrl(response.finalUrl);
        if (final.href !== item.url || final.origin !== this.allowedOrigin) {
          item.state = "failed";
          item.error = "REDIRECT_NOT_ALLOWED";
          this.error = "The loader followed a redirect or returned a URL outside the requested scope";
          this.state = "failed";
          break;
        }
        if (response.statusCode === 429 || response.statusCode === 503) {
          item.state = "failed";
          item.statusCode = response.statusCode;
          item.error = "UPSTREAM_RATE_LIMITED";
          this.error = "Upstream is rate limiting requests; crawl stopped";
          this.state = "failed";
          break;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          item.state = "failed";
          item.statusCode = response.statusCode;
          item.error = "HTTP_ERROR";
          continue;
        }
        if (Buffer.byteLength(response.html, "utf8") > this.maxHtmlBytes) {
          item.state = "failed";
          item.error = "RESPONSE_TOO_LARGE";
          continue;
        }
        const contentType = response.contentType?.split(";")[0]?.trim().toLowerCase();
        if (contentType && contentType !== "text/html" && contentType !== "application/xhtml+xml") {
          item.state = "skipped";
          item.statusCode = response.statusCode;
          item.error = "NOT_HTML";
          continue;
        }

        if (this.options.onPage) {
          await waitFor(this.options.onPage({
            url: item.url,
            depth: item.depth,
            finalUrl: final.href,
            statusCode: response.statusCode,
            contentType: response.contentType,
            html: response.html,
          }, signal), signal);
        }
        if (this.controller.signal.aborted) {
          item.state = "cancelled";
          item.error = "CANCELLED";
          break;
        }

        item.statusCode = response.statusCode;
        item.state = "completed";
        if (item.depth < this.maxDepth) {
          const links = discoverSameOriginLinks(response.html, final.href, {
            allowedOrigin: this.allowedOrigin,
            maxLinks: Math.min(this.maxDiscovered, 5000),
          });
          let added = 0;
          for (const link of links) {
            if (this.enqueue(link.url, item.depth + 1)) added += 1;
          }
          item.discoveredLinks = added;
        } else {
          item.discoveredLinks = 0;
        }
      } catch (error) {
        if (this.controller.signal.aborted) {
          item.state = "cancelled";
          item.error = "CANCELLED";
          break;
        }
        item.state = "failed";
        item.error = signal.aborted ? "REQUEST_TIMEOUT" : errorMessage(error);
      }
    }

    if (this.controller.signal.aborted || this.state === "cancelled") {
      this.state = "cancelled";
      this.finishPending("cancelled", "CANCELLED");
    } else if (this.state === "failed") {
      this.finishPending("skipped", "CRAWL_FAILED");
    } else {
      this.state = "completed";
      this.finishPending("skipped", "PAGE_LIMIT_REACHED");
    }
    this.finishedAt ??= new Date().toISOString();
    return this.snapshot();
  }
}
