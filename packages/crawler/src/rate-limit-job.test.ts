import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrawlJob, type CrawlLoadedPage } from "./job.js";
import { DomainRateLimiter } from "./rate-limit.js";

const ORIGIN = "https://example.com";

describe("rate-limited crawl job integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-18T12:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("releases permits and shares Retry-After cooldown across crawl jobs", async () => {
    const limiter = new DomainRateLimiter({
      minDelayMs: 0,
      maxRetries: 0,
      baseBackoffMs: 1000,
      maxBackoffMs: 10000,
      jitterRatio: 0,
    });
    const loadPage = vi.fn(async (url: string): Promise<CrawlLoadedPage> => ({
      finalUrl: url,
      statusCode: url.endsWith("/busy") ? 429 : 200,
      contentType: "text/html",
      html: "<h1>fixture</h1>",
      headers: url.endsWith("/busy") ? { "Retry-After": "5" } : {},
    }));
    const opts = {
      maxDepth: 0,
      canFetch: async () => true,
      acquirePermit: (url: string, signal: AbortSignal) => limiter.acquire(url, signal),
      loadPage,
    };

    const first = new CrawlJob({ ...opts, seedUrl: ORIGIN + "/busy" });
    const firstResult = await first.start();
    expect(firstResult.state).toBe("failed");
    expect(firstResult.pages[0]?.error).toBe("UPSTREAM_RATE_LIMITED");
    expect(loadPage).toHaveBeenCalledTimes(1);

    const second = new CrawlJob({ ...opts, seedUrl: ORIGIN + "/good" });
    const pending = second.start();
    await vi.advanceTimersByTimeAsync(4999);
    expect(loadPage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.state).toBe("completed");
    expect(result.completed).toBe(1);
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  it("releases the slot after a failed load", async () => {
    const limiter = new DomainRateLimiter({ minDelayMs: 0, maxRetries: 0 });
    const loadPage = vi.fn(async (url: string): Promise<CrawlLoadedPage> => {
      if (url.endsWith("/bad")) throw new Error("Network failed");
      return { finalUrl: url, statusCode: 200, contentType: "text/html", html: "<h1>OK</h1>" };
    });
    const opts = {
      maxDepth: 0,
      canFetch: async () => true,
      acquirePermit: (url: string, signal: AbortSignal) => limiter.acquire(url, signal),
      loadPage,
    };
    const failed = await new CrawlJob({ ...opts, seedUrl: ORIGIN + "/bad" }).start();
    expect(failed.failed).toBe(1);
    const succeeded = await new CrawlJob({ ...opts, seedUrl: ORIGIN + "/good" }).start();
    expect(succeeded.completed).toBe(1);
    expect(loadPage).toHaveBeenCalledTimes(2);
  });
});
