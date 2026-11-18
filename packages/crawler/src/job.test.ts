import { describe, expect, it, vi } from "vitest";
import {
  CrawlJob,
  type CrawlJobOptions,
  type CrawlLoadedPage,
  type CrawlRequestContext,
} from "./job.js";

const ORIGIN = "https://example.com";
const SEED = ORIGIN + "/start";

type FixturePage = {
  html: string;
  statusCode?: number;
  finalUrl?: string;
  contentType?: string | null;
};

function fixtureOptions(
  pages: Record<string, FixturePage>,
  overrides: Partial<CrawlJobOptions> = {},
) {
  const canFetch = vi.fn(async () => true);
  const acquirePermit = vi.fn(async () => {});
  const loadPage = vi.fn(async (url: string, context: CrawlRequestContext): Promise<CrawlLoadedPage> => {
    expect(context.maxRedirects).toBe(0);
    expect(context.maxBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(context.timeoutMs).toBeLessThanOrEqual(30_000);
    expect(context.signal).toBeInstanceOf(AbortSignal);
    const page = pages[url];
    if (!page) throw new Error("Missing fixture for " + url);
    return {
      finalUrl: page.finalUrl ?? url,
      statusCode: page.statusCode ?? 200,
      contentType: page.contentType === undefined ? "text/html" : page.contentType,
      html: page.html,
    };
  });
  const options: CrawlJobOptions = {
    seedUrl: SEED,
    canFetch,
    acquirePermit,
    loadPage,
    ...overrides,
  };
  return { options, canFetch, acquirePermit, loadPage };
}

describe("CrawlJob lifecycle and bounded discovery", () => {
  it("visits in breadth-first order and strictly caps attempted pages", async () => {
    const { options, loadPage } = fixtureOptions({
      [SEED]: {
        html: '<a href="/a">A</a><a href="/a#one">Duplicate</a><a href="/b">B</a>' +
          '<a href="https://outside.example/leak">Outside</a><a href="/download.pdf">PDF</a>',
      },
      [ORIGIN + "/a"]: { html: '<a href="/c">C</a>' },
      [ORIGIN + "/b"]: { html: '<a href="/d">D</a>' },
    }, { maxPages: 3, maxDepth: 2 });

    const job = new CrawlJob(options);
    expect(job.snapshot().state).toBe("queued");
    expect(job.snapshot().queued).toBe(1);
    const result = await job.start();

    expect(result.state).toBe("completed");
    expect(result.attempted).toBe(3);
    expect(result.completed).toBe(3);
    expect(result.queued).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.discovered).toBe(5);
    expect(result.pages.map((item) => [item.url, item.depth, item.state])).toEqual([
      [SEED, 0, "completed"],
      [ORIGIN + "/a", 1, "completed"],
      [ORIGIN + "/b", 1, "completed"],
      [ORIGIN + "/c", 2, "skipped"],
      [ORIGIN + "/d", 2, "skipped"],
    ]);
    expect(loadPage.mock.calls.map(([url]) => url)).toEqual([
      SEED, ORIGIN + "/a", ORIGIN + "/b",
    ]);
    expect(result.pages[3]?.error).toBe("PAGE_LIMIT_REACHED");
    expect(result.pages.some((page) => page.url.includes("outside.example"))).toBe(false);
  });

  it("does not discover descendants past the maximum depth", async () => {
    const { options } = fixtureOptions({
      [SEED]: { html: '<a href="/a">A</a>' },
      [ORIGIN + "/a"]: { html: '<a href="/b">B</a>' },
    }, { maxDepth: 1, maxPages: 10 });
    const result = await new CrawlJob(options).start();
    expect(result.pages.map((p) => p.url)).toEqual([SEED, ORIGIN + "/a"]);
    expect(result.completed).toBe(2);
    expect(result.pages[1]?.discoveredLinks).toBe(0);
  });

  it("caps discovered URLs even when one page has many links", async () => {
    const { options, loadPage } = fixtureOptions({
      [SEED]: { html: Array.from({ length: 20 }, (_, i) =>
        '<a href="/item/' + i + '">Item</a>').join("") },
    }, { maxDiscovered: 4, maxPages: 1 });
    const result = await new CrawlJob(options).start();
    expect(result.discovered).toBe(4);
    expect(result.completed).toBe(1);
    expect(result.pages[0]?.discoveredLinks).toBe(3);
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  it("checks permission for each URL before obtaining a permit or loading", async () => {
    const { options, acquirePermit, loadPage } = fixtureOptions({
      [SEED]: { html: '<a href="/private">Hidden</a><a href="/public">Public</a>' },
      [ORIGIN + "/public"]: { html: "<p>Public content</p>" },
    }, {
      canFetch: vi.fn(async (url: string) => !url.endsWith("/private")),
    });
    const result = await new CrawlJob(options).start();
    expect(result.state).toBe("completed");
    expect(result.pages[1]).toMatchObject({
      url: ORIGIN + "/private", state: "skipped", error: "NOT_PERMITTED",
    });
    expect(acquirePermit).toHaveBeenCalledTimes(2);
    expect(loadPage.mock.calls.map(([url]) => url)).toEqual([SEED, ORIGIN + "/public"]);
  });

  it("fails closed if the site-policy provider throws", async () => {
    const { options, loadPage } = fixtureOptions({}, {
      canFetch: vi.fn(async () => { throw new Error("Robots policy unavailable"); }),
    });
    const result = await new CrawlJob(options).start();
    expect(result.state).toBe("failed");
    expect(result.failed).toBe(1);
    expect(result.error).toContain("Robots policy unavailable");
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("rejects redirects instead of expanding the crawl to another origin", async () => {
    const { options, loadPage } = fixtureOptions({
      [SEED]: {
        finalUrl: "https://outside.example/landing",
        html: '<a href="https://outside.example/next">Next</a>',
      },
    });
    const result = await new CrawlJob(options).start();
    expect(result.state).toBe("failed");
    expect(result.pages[0]?.error).toBe("REDIRECT_NOT_ALLOWED");
    expect(result.discovered).toBe(1);
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  it("stops on an upstream 429 and does not retry or visit later URLs", async () => {
    const { options, loadPage } = fixtureOptions({
      [SEED]: { html: '<a href="/busy">Busy</a><a href="/after">After</a>' },
      [ORIGIN + "/busy"]: { html: "", statusCode: 429 },
    });
    const result = await new CrawlJob(options).start();
    expect(result.state).toBe("failed");
    expect(result.attempted).toBe(2);
    expect(result.pages[1]).toMatchObject({
      state: "failed", statusCode: 429, error: "UPSTREAM_RATE_LIMITED",
    });
    expect(result.pages[2]?.state).toBe("skipped");
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  it("records page failures but continues to other permitted pages", async () => {
    const { options } = fixtureOptions({
      [SEED]: { html: '<a href="/missing">Missing</a><a href="/good">Good</a>' },
      [ORIGIN + "/missing"]: { html: "", statusCode: 404 },
      [ORIGIN + "/good"]: { html: "<h1>Good</h1>" },
    });
    const result = await new CrawlJob(options).start();
    expect(result.state).toBe("completed");
    expect(result.completed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.pages[1]?.error).toBe("HTTP_ERROR");
  });

  it("skips non-HTML and rejects an overlarge HTML body", async () => {
    const { options } = fixtureOptions({
      [SEED]: { html: '<a href="/json">JSON</a><a href="/huge">Huge</a>' },
      [ORIGIN + "/json"]: { html: '{"ok":true}', contentType: "application/json" },
      [ORIGIN + "/huge"]: { html: "x".repeat(1300) },
    }, { maxHtmlBytes: 1024 });
    const result = await new CrawlJob(options).start();
    expect(result.pages[1]?.error).toBe("NOT_HTML");
    expect(result.pages[2]?.error).toBe("RESPONSE_TOO_LARGE");
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("supports cancellation while a fetch is running", async () => {
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const loadPage = vi.fn(async () => {
      notifyStarted();
      return new Promise<CrawlLoadedPage>(() => {
        // A deliberately uncooperative loader: the job must still stop waiting
        // when the AbortSignal is triggered.
      });
    });
    const { options } = fixtureOptions({}, { loadPage });
    const job = new CrawlJob(options);
    const work = job.start();
    await started;
    job.cancel();
    const result = await work;
    expect(result.state).toBe("cancelled");
    expect(result.pages[0]?.state).toBe("cancelled");
    expect(result.attempted).toBe(1);
    expect(result.completed).toBe(0);
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  it("supports cancellation before start and prevents restarting a finished job", async () => {
    const { options, loadPage } = fixtureOptions({ [SEED]: { html: "<p>Hi</p>" } });
    const cancelledJob = new CrawlJob(options);
    cancelledJob.cancel();
    expect((await cancelledJob.start()).state).toBe("cancelled");
    expect(loadPage).not.toHaveBeenCalled();

    const job = new CrawlJob(options);
    expect((await job.start()).completed).toBe(1);
    expect((await job.start()).completed).toBe(1);
    expect(loadPage).toHaveBeenCalledTimes(1);
    job.cancel();
    expect(job.snapshot().state).toBe("completed");
  });

  it("forwards successful pages to onPage without retaining HTML", async () => {
    const onPage = vi.fn(async () => {});
    const { options } = fixtureOptions({
      [SEED]: { html: "<h1>Example</h1><p>Sensitive fixture content</p>" },
    }, { onPage });
    const job = new CrawlJob(options);
    const result = await job.start();
    expect(onPage).toHaveBeenCalledWith(expect.objectContaining({
      url: SEED, depth: 0, html: expect.stringContaining("Sensitive fixture content"),
    }), expect.any(AbortSignal));
    expect(JSON.stringify(result)).not.toContain("Sensitive fixture content");
    result.pages[0]!.url = "https://changed.example/";
    expect(job.snapshot().pages[0]?.url).toBe(SEED);
  });

  it("validates origin and resource limits before doing any work", () => {
    const { options } = fixtureOptions({});
    expect(() => new CrawlJob({ ...options, allowedOrigin: "https://other.example/" })).toThrow(RangeError);
    expect(() => new CrawlJob({ ...options, seedUrl: "http://127.0.0.1/" })).toThrow();
    expect(() => new CrawlJob({ ...options, maxPages: 0 })).toThrow(RangeError);
    expect(() => new CrawlJob({ ...options, maxPages: 101 })).toThrow(RangeError);
    expect(() => new CrawlJob({ ...options, maxDepth: 9 })).toThrow(RangeError);
    expect(() => new CrawlJob({ ...options, maxDiscovered: 0 })).toThrow(RangeError);
    expect(() => new CrawlJob({ ...options, requestTimeoutMs: 999 })).toThrow(RangeError);
    expect(() => new CrawlJob({ ...options, maxHtmlBytes: 300 })).toThrow(RangeError);
  });
});
