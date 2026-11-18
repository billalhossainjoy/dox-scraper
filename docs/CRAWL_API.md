# Crawl Job REST API — Issue #17

The Hono API supports persistent, asynchronous crawl jobs through
`@dox-scraper/crawler` and `@dox-scraper/storage`. The crawl API is
**disabled by default**. It uses the same bearer token as `POST /v1/scrape`.

## Prerequisites

Only enable crawling for websites that you are permitted to crawl.
On the Raspberry Pi, ensure the Node process owns the database path and
the deployment is authenticated (and reachable only through your
private tunnel/access policy). The crawler currently permits **one
active job per process** and is not a distributed work queue.

Configure the root `.env` with exact origin(s), not wildcard domains:

```dotenv
DOX_SCRAPER_API_KEY=your-long-random-secret
DOX_ENABLE_CRAWL_API=true
DOX_CRAWL_ALLOWED_ORIGINS=https://example.com,https://docs.example.com
DOX_CRAWL_DB_PATH=./storage/dox.sqlite
```

A missing allowlist, disabled switch or missing bearer key prevents
crawling. The SQLite store upgrades from schema v1 to v2 and records an
owner digest derived from the configured API key. It never stores the
secret itself. Jobs from older schema versions are unowned and cannot
be retrieved via the authenticated crawl API. Rotating the API key
prevents access to jobs created under the previous key.

## Create a job

```bash
curl -i -X POST http://127.0.0.1:3000/v1/crawl \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","maxPages":20,"maxDepth":2}'
```

Returns HTTP **202 Accepted** with `{ "success": true, "data": { ...job } }`.
The `Location` header points to `/v1/crawl/{id}`. The job may
initially be `queued` or `running`. Limits per job: 1–50 page
attempts, depth 0–3, and up to 250 discovered URLs. One active job
per API process (otherwise HTTP 429).

## Poll status

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
  http://127.0.0.1:3000/v1/crawl/JOB_ID
```

States: `queued`, `running`, `completed`, `failed`, `cancelled`.
The response also includes attempted/completed/failed/skipped counts,
timestamps, current queue counts and per-page URLs, depths and statuses.

## Paginate page results

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
  'http://127.0.0.1:3000/v1/crawl/JOB_ID/results?limit=20&offset=0'
```

Returns `{ "success": true, "data": {
  "results": [...], "total": 20, "limit": 20, "offset": 0 } }`.
Results are ordered by discovery ordinal and contain `url`,
`markdown`, `contentText`, `metadata`, `markdownSha256`,
`contentBytes`, and `scrapedAt`. The total counts **stored page
results**, not all discovered URLs; failed/skipped pages have no
Markdown result. `limit` is 1–50 (default 20), `offset` is
0–1,000,000 (default 0).

## Cancel

```bash
curl -X DELETE -H "Authorization: Bearer YOUR_API_KEY" \
  http://127.0.0.1:3000/v1/crawl/JOB_ID
```

Returns the latest snapshot. Cancelling an already cancelled job is
idempotent; completed/failed jobs return 409. The crawler passes
`AbortSignal` to network operations and releases rate-limit leases.

## Safety controls

- **Explicit exact-origin allowlist**; subdomains count as different
  origins. No wildcard or public discovery endpoint.
- Before fetching pages, request `/robots.txt` from that origin using
  the SSRF-hardened HTTP fetcher with redirects disabled and 64 KiB
  response cap. Parse Allow/Disallow with the `robots-parser` library
  using the `DoxScraper` user agent. Follow standard 404/410
  semantics only for operator-approved origins.
- Refuse to crawl on robots.txt 401/403/429/503, unexpected redirects,
  oversized/malformed policies, and policy network failures.
- Respect `Crawl-delay` (up to 30 seconds; longer values cause a
  fail-closed job) alongside a minimum 2-second per-hostname spacing
  and a shared one-request-per-host limiter.
- The crawler disables auto-redirects and validates every destination
  against the public-address/SSRF policy. Blocks external origins,
  follows `rel=nofollow` by default and never requests more than the
  configured page/depth/URL budget.
- Progress and extracted Markdown are checkpointed into SQLite as the
  job runs. After an interrupted server restart, unfinished jobs are
  marked failed, not automatically restarted without fresh permission.
- Job reads, results and cancellations require the **same bearer key**
  used to create the job. Unknown/unowned IDs return 404.
- The scheduler and rate limiter are **in-memory, per-process**. Do not
  deploy multiple independent instances against the same SQLite file
  or claim globally coordinated rate limits.
- Content is unencrypted public webpage data. Never store private
  user content, credentials or session-specific responses in the
  crawler's SQLite store.

This API is intended for a privately operated, explicitly allowlisted
crawl workload. It is **not yet an unrestricted public crawling platform**.
