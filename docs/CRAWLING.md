# Link discovery — Issue #9

The `@dox-scraper/crawler` package currently provides offline
same-origin URL discovery. It does not perform network requests.

```ts
import { discoverSameOriginLinks } from "@dox-scraper/crawler";

const html = '<a href="/news">News</a><a href="https://other.org">External</a>';
const links = discoverSameOriginLinks(html, "https://example.com/start", {
  allowedOrigin: "https://example.com/",
  maxLinks: 100,
});
// [{ url: "https://example.com/news", text: "News" }]
```

Discovered URLs are normalized against the fetched page's URL: HTTP(S)
only, with no embedded credentials, no fragments, and query strings
preserved. By default, rel=nofollow links and obvious non-HTML assets
are excluded. Subdomains and different ports are outside the scope.

**Important:** Discovery does not authorize fetching. The upcoming
crawler must enforce site terms, robots.txt, per-domain rate limits,
timeouts, SSRF checks, and a bounded job queue before requesting URLs.
Do not expose unrestricted crawling publicly.

## Sitemap discovery — Issue #10

Discover sitemap documents declared in `robots.txt` and the conventional
`/sitemap.xml`; recursively parse regular XML `urlset` and
`sitemapindex` documents with a bounded, sequential request budget.

```ts
import { discoverSitemapUrls } from "@dox-scraper/crawler";

const result = await discoverSitemapUrls("https://example.com/", {
  maxSitemaps: 10,
  maxUrls: 1000,
  timeoutMs: 15000,
  maxBytes: 1048576,
});
console.log(result.pageUrls);
console.log(result.errors);
```

Only sitemap documents and page URLs on the seed's **exact origin** are
accepted; external sitemap declarations and cross-origin page URLs are
excluded. Requests use the existing SSRF-resistant HTTP fetcher.
The parser removes fragments, deduplicates URLs, and excludes common
non-HTML assets. A missing robots.txt file is not fatal; the fallback
`/sitemap.xml` is still checked. HTTP 429/503 stops further requests.
Compressed `.xml.gz` sitemaps are not yet supported; such declarations
are reported as unsupported rather than decoded.

Defaults are 10 sitemap documents, 1,000 discovered page URLs, 15 seconds
per request, and 1 MiB per sitemap body. Allowed maxima are 50 documents,
5,000 URLs, 30 seconds and 2 MiB. This operation still needs robots.txt
**Allow/Disallow enforcement**, per-domain pacing and a real crawl queue
before it should power an externally accessible crawl endpoint.

## Bounded crawl jobs — Issue #11

`CrawlJob` is an **in-memory, sequential breadth-first crawl engine**. It
tracks per-URL states (`queued`, `active`, `completed`, `failed`,
`skipped`, `cancelled`), totals, start/finish timestamps and job lifecycle.
Results are available using `job.snapshot()`. A job runs only when you call
`job.start()`, and you can stop it using `job.cancel()`.

```ts
import { CrawlJob } from "@dox-scraper/crawler";
import { fetchPage } from "@dox-scraper/fetcher";

// Example wiring for a future internal service. The two policy functions
// MUST be implemented first: never return true unconditionally in production.
const job = new CrawlJob({
  seedUrl: "https://example.com",
  maxPages: 10,
  maxDepth: 2,
  maxDiscovered: 100,
  canFetch: checkRobotsAndSitePermission,
  acquirePermit: waitForOriginRateLimit,
  loadPage: async (url, limits) => {
    const response = await fetchPage(url, {
      timeoutMs: limits.timeoutMs,
      maxBytes: limits.maxBytes,
      maxRedirects: limits.maxRedirects, // zero; do not auto-follow redirects
    });
    return {
      finalUrl: response.finalUrl,
      statusCode: response.statusCode,
      contentType: response.contentType,
      html: response.html,
    };
  },
  onPage: async (page) => {
    // Store or extract page.html in a future persistence layer.
  },
});
const result = await job.start();
console.log(result.state, result.pages);
```

The example above is an **integration sketch**, not a copy-and-run example:
`checkRobotsAndSitePermission` and `waitForOriginRateLimit` are intentionally
not implemented yet. Their policies must be supplied and tested before any
real multi-page crawling. There is no public crawling endpoint.

Built-in bounds: 1–100 page attempts (default 20), 0–8 crawl depth
(default 2), 1–5,000 discovered URL records (default 500), 1 KiB–2 MiB
per returned HTML page (default 1 MiB), 1–30 seconds per request
(default 15 seconds). Jobs run one page at a time to limit resource load.

Each page must first pass `canFetch` (robots/site permissions) and
`acquirePermit` (origin rate pacing). Policy exceptions stop the job.
The loader must be SSRF-safe, must honor `AbortSignal`, and must disable
redirect-following; the job detects unexpected redirect results and stops.
HTTP 429 and 503 stop the job with no retries. Links are deduplicated,
must remain in the exact seed origin and never exceed the depth/page
discovery budgets. Page HTML is passed to `onPage` but is **not stored**
in job snapshots. Job state is volatile (not persisted after restarts).

Before using this with real sites, implement and test robots.txt
Allow/Disallow policy, request pacing and any site-specific restrictions.
Issue #12 handles per-origin rate limiting; persistence and API job endpoints
are later roadmap tasks.

## Per-domain rate limiting — Issue #12

`DomainRateLimiter` is a conservative, in-memory, FIFO per-**hostname**
scheduler. Share **one instance across all crawl jobs** in a Node process.
It enforces minimum spacing between request start times and an active-request
concurrency cap. It also records upstream throttling and access denials.

Defaults:

| Setting | Default |
| --- | ---: |
| Start-to-start spacing per hostname | 1,500 ms |
| Concurrent requests per hostname | 1 |
| Pending requests per hostname | 100 |
| Retries on HTTP 429/503 | 2 |
| Initial exponential backoff | 2,000 ms |
| Maximum exponential backoff | 30,000 ms |
| Extra random jitter | 0–25% |
| Pause after repeated throttles | 60,000 ms after 3 |
| Pause on HTTP 403 | 300,000 ms |
| Tracked hostnames per process | 500 |

HTTP `Retry-After` response headers (seconds or HTTP dates) take
precedence when longer than backoff. The scheduler never shortens a
valid server-requested waiting period. It does not rotate proxies,
identities or user agents to bypass restrictions. It retries only 429/503
with bounded exponential backoff; 403 returns immediately and pauses
that hostname. Network exceptions are not retried automatically.

### Safe integration with CrawlJob

Pass a real site-permission policy, the shared limiter's `acquire()`
method, and an SSRF-safe HTTP loader with redirects disabled:

```ts
import { CrawlJob, DomainRateLimiter } from "@dox-scraper/crawler";
import { fetchPage } from "@dox-scraper/fetcher";

const limiter = new DomainRateLimiter({ minDelayMs: 2000, maxConcurrency: 1 });
const job = new CrawlJob({
  seedUrl: "https://example.com/",
  maxPages: 10,
  maxDepth: 2,
  // REQUIRED: implement robots.txt Allow/Disallow and website permissions.
  canFetch: checkRobotsAndSitePermission,
  acquirePermit: (url, signal) => limiter.acquire(url, signal),
  loadPage: async (url, limits) => {
    // Production loader must respect the provided AbortSignal.
    const response = await fetchPage(url, {
      maxRedirects: 0,
      maxBytes: limits.maxBytes,
      timeoutMs: limits.timeoutMs,
    });
    return {
      finalUrl: response.finalUrl,
      statusCode: response.statusCode,
      contentType: response.contentType,
      html: response.html,
      headers: response.headers, // includes Retry-After
    };
  },
});
```

This is an **integration sketch**, not production-ready copy/paste code.
The site-permission function has deliberately not been implemented. The
current fetcher uses its own timeout and does not yet accept the job's
abort signal. Both requirements must be met before deploying crawl jobs.
The job releases permits on every success/failure/cancellation path;
it observes 403, 429, 503 and Retry-After before releasing them.

Rate limiting is **per-process only**, not globally coordinated across
multiple worker instances. It is not a way to bypass access restrictions.
A robots.txt parser and enforceable policy are still required.
