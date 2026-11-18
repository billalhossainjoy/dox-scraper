import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  CrawlJob,
  DomainRateLimiter,
  type CrawlLoadedPage,
  type CrawlRequestContext,
  type CrawlSnapshot,
} from "@dox-scraper/crawler";
import { fetchPage, validateTargetUrl, type FetchPageResult } from "@dox-scraper/fetcher";
import { createPersistedCrawlJob, type SqliteCrawlStore } from "@dox-scraper/storage";
// robots-parser@3.0.1 is CommonJS with incorrect published NodeNext
// declarations. Load its real callable CJS export explicitly.
const robotsParser = createRequire(import.meta.url)("robots-parser") as (
  url: string,
  contents: string,
) => {
  isAllowed: (url: string, agent?: string) => boolean | undefined;
  getCrawlDelay: (agent?: string) => number | undefined;
};

export interface CrawlRequest {
  url: string;
  maxPages?: number | undefined;
  maxDepth?: number | undefined;
}

export interface CrawlManagerOptions {
  store: SqliteCrawlStore;
  allowedOrigins: string[];
  /** Tests can replace network IO but cannot bypass robots/site checks. */
  fetchRobots?: (url: string, signal: AbortSignal) => Promise<FetchPageResult>;
  loadPage?: (url: string, context: CrawlRequestContext) => Promise<CrawlLoadedPage>;
  limiter?: DomainRateLimiter;
  maxActiveJobs?: number;
}

export class CrawlApiError extends Error {
  constructor(
    public readonly code:
      "ORIGIN_NOT_ALLOWED" | "CRAWL_BUSY" | "INVALID_TARGET" |
      "JOB_NOT_FOUND" | "JOB_FINISHED",
    public readonly status: 400 | 403 | 404 | 409 | 429,
    message: string,
  ) {
    super(message);
    this.name = "CrawlApiError";
  }
}

interface SitePolicy {
  allowed: (url: string) => boolean;
  delayMs: number;
}

const USER_AGENT = "DoxScraper/0.1 (+https://github.com/billalhossainjoy/dox-scraper)";
const ROBOTS_TOKEN = "DoxScraper";
const DEFAULT_SPACING_MS = 2000;

/** No implicit / wildcard origins. Each one must be a canonical HTTP(S) origin. */
export function verifiedOrigins(origins: string[]): Set<string> {
  const allowed = new Set<string>();
  for (const raw of origins) {
    const url = validateTargetUrl(raw);
    if (url.href !== url.origin + "/" || raw !== url.origin) {
      throw new TypeError("Crawl allowlist entries must be exact origins, without paths or query strings");
    }
    allowed.add(url.origin);
  }
  return allowed;
}

export function ownerDigestForKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error("Cancelled");
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", stop);
      reject(signal.reason ?? new Error("Cancelled"));
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * Single-instance crawl manager for the private Raspberry Pi MVP.
 * Only one crawl runs at once by default. Origin allowlist, robots rules,
 * rate limiting, SSRF-safe fetcher and bounded page budgets are mandatory.
 */
export class CrawlManager {
  readonly store: SqliteCrawlStore;
  private readonly allowedOrigins: Set<string>;
  private readonly limiter: DomainRateLimiter;
  private readonly robotsFetcher: (url: string, signal: AbortSignal) => Promise<FetchPageResult>;
  private readonly pageLoader: (url: string, context: CrawlRequestContext) => Promise<CrawlLoadedPage>;
  private readonly maxActiveJobs: number;
  private readonly active = new Map<string, CrawlJob>();
  private readonly requestStarted = new Map<string, number>();

  constructor(options: CrawlManagerOptions) {
    this.store = options.store;
    this.allowedOrigins = verifiedOrigins(options.allowedOrigins);
    this.limiter = options.limiter ?? new DomainRateLimiter({
      minDelayMs: DEFAULT_SPACING_MS,
      maxConcurrency: 1,
      maxRetries: 0,
    });
    this.maxActiveJobs = options.maxActiveJobs ?? 1;
    if (!Number.isInteger(this.maxActiveJobs) || this.maxActiveJobs < 1 ||
        this.maxActiveJobs > 2) {
      throw new RangeError("maxActiveJobs must be 1 or 2");
    }
    this.robotsFetcher = options.fetchRobots ?? ((url, signal) => fetchPage(url, {
      signal, maxRedirects: 0, maxBytes: 64 * 1024,
      timeoutMs: 10_000, userAgent: USER_AGENT,
    }));
    this.pageLoader = options.loadPage ?? (async (url, context) => {
      const response = await fetchPage(url, {
        signal: context.signal, maxRedirects: 0,
        maxBytes: context.maxBytes, timeoutMs: context.timeoutMs,
        userAgent: USER_AGENT,
      });
      return {
        finalUrl: response.finalUrl,
        statusCode: response.statusCode,
        contentType: response.contentType,
        html: response.html,
        headers: response.headers,
      };
    });
    // This process is the exclusive job owner; interrupted jobs are marked
    // failed on restart rather than blindly resuming network operations.
    this.store.recoverInterruptedJobs();
  }

  private async loadPolicy(seed: URL, signal: AbortSignal): Promise<SitePolicy> {
    const url = seed.origin + "/robots.txt";
    const permit = await this.limiter.acquire(url, signal);
    let response: FetchPageResult;
    try {
      this.requestStarted.set(seed.origin, Date.now());
      response = await this.robotsFetcher(url, signal);
      permit.observe(response.statusCode, typeof response.headers["retry-after"] === "string"
        ? response.headers["retry-after"] : null);
    } finally {
      permit.release();
    }
    if (response.finalUrl !== url) {
      throw new Error("robots.txt redirected; refusing crawl without verified policy");
    }
    if (response.statusCode === 404 || response.statusCode === 410) {
      // Missing policy on an explicitly operator-approved origin follows RFC
      // semantics; all other failure/ambiguous responses fail closed.
      return { allowed: () => true, delayMs: DEFAULT_SPACING_MS };
    }
    if (response.statusCode !== 200) {
      throw new Error("robots.txt unavailable (HTTP " + response.statusCode + ")");
    }
    const type = response.contentType?.split(";")[0]?.trim().toLowerCase();
    if (type && type !== "text/plain") {
      throw new Error("robots.txt returned an unexpected content type");
    }
    if (Buffer.byteLength(response.html, "utf8") > 64 * 1024) {
      throw new Error("robots.txt exceeded the policy size limit");
    }
    const parsed = robotsParser(url, response.html);
    const rawDelay = parsed.getCrawlDelay(ROBOTS_TOKEN) ?? 0;
    if (!Number.isFinite(rawDelay) || rawDelay < 0 || rawDelay > 30) {
      throw new Error("robots.txt requires an unsupported crawl delay; refusing to crawl");
    }
    return {
      allowed: (candidate) => parsed.isAllowed(candidate, ROBOTS_TOKEN) === true,
      delayMs: Math.max(DEFAULT_SPACING_MS, Math.ceil(rawDelay * 1000)),
    };
  }

  submit(request: CrawlRequest, ownerDigest: string): CrawlSnapshot {
    const seed = validateTargetUrl(request.url);
    if (!this.allowedOrigins.has(seed.origin)) {
      throw new CrawlApiError(
        "ORIGIN_NOT_ALLOWED", 403, "Crawl origin is not on the operator allowlist",
      );
    }
    if (this.active.size >= this.maxActiveJobs) {
      throw new CrawlApiError("CRAWL_BUSY", 429, "Crawl worker is already processing a job");
    }
    const maxPages = request.maxPages ?? 20;
    const maxDepth = request.maxDepth ?? 2;
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50 ||
        !Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 3) {
      throw new CrawlApiError("INVALID_TARGET", 400, "Invalid crawl page/depth budget");
    }

    // Each job verifies its origin's robots policy before its first page.
    // A rejected/missing/unparseable policy fails the job closed.
    let policyPromise: Promise<SitePolicy> | undefined;
    const policyFor = (signal: AbortSignal) => {
      policyPromise ??= this.loadPolicy(seed, signal);
      return policyPromise;
    };
    const job = createPersistedCrawlJob(this.store, {
      seedUrl: seed.href,
      maxPages,
      maxDepth,
      maxDiscovered: Math.min(250, maxPages * 8),
      maxHtmlBytes: 1024 * 1024,
      requestTimeoutMs: 15_000,
      canFetch: async (url, signal) => {
        signal.throwIfAborted();
        const policy = await policyFor(signal);
        signal.throwIfAborted();
        return policy.allowed(url);
      },
      acquirePermit: async (url, signal) => {
        const policy = await policyFor(signal);
        const lease = await this.limiter.acquire(url, signal);
        try {
          const gap = Math.max(0,
            (this.requestStarted.get(seed.origin) ?? 0) + policy.delayMs - Date.now());
          await sleep(gap, signal);
          this.requestStarted.set(seed.origin, Date.now());
          return lease;
        } catch (error) {
          lease.release();
          throw error;
        }
      },
      loadPage: this.pageLoader,
    });

    // Assign owner BEFORE scheduling the job, preventing cross-key access.
    try {
      this.store.assignOwner(job.id, ownerDigest);
    } catch (error) {
      this.store.deleteJob(job.id);
      throw error;
    }

    this.active.set(job.id, job);
    void (async () => {
      try {
        await job.start();
      } catch {
        // Fail closed without exposing raw network/error details in API.
        this.store.failJob(job.id, "CRAWL_RUNTIME_ERROR");
      } finally {
        this.active.delete(job.id);
      }
    })();
    return job.snapshot();
  }

  getJob(id: string, ownerDigest: string): CrawlSnapshot {
    const job = this.store.getOwnedJob(id, ownerDigest);
    if (!job) throw new CrawlApiError("JOB_NOT_FOUND", 404, "Crawl job not found");
    return job;
  }

  results(id: string, ownerDigest: string, limit: number, offset: number) {
    this.getJob(id, ownerDigest);
    return this.store.listPageResults(id, limit, offset);
  }

  cancel(id: string, ownerDigest: string): CrawlSnapshot {
    const saved = this.getJob(id, ownerDigest);
    if (saved.state === "cancelled") return saved;
    if (saved.state === "completed" || saved.state === "failed") {
      throw new CrawlApiError("JOB_FINISHED", 409, "The job has already finished");
    }
    const running = this.active.get(id);
    if (!running) {
      throw new CrawlApiError("JOB_FINISHED", 409, "Job is no longer running");
    }
    running.cancel();
    return this.getJob(id, ownerDigest);
  }

  cancelActive(): void {
    for (const job of this.active.values()) job.cancel();
  }
}
