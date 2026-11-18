# SQLite persistence — Issue #16

Dox Scraper now includes `@dox-scraper/storage`, using **Node.js 24's
built-in `node:sqlite` DatabaseSync API**. No native npm SQLite bindings,
postinstall scripts or ORM are required. SQLite runs on the Raspberry Pi
as part of the existing Node process. Use Node **24.15+**.

## What is durable?

The schema (currently v2) has four main data tables plus an ownership table:

- `crawl_jobs`: lifecycle, budgets, progress counters, timestamps and errors
- `crawl_pages`: discovered URLs, depth, status, errors and discovery counts
- `page_results`: extracted Markdown/text, bounded JSON metadata and
  SHA-256 Markdown fingerprints
- `crawl_job_owners`: keyed hashes of authorized API credentials for scoped job access
- `cache_entries`: optional persistent public HTML cache primitives,
  ETag/Last-Modified, expiry and SHA-256 HTML fingerprints

A `schema_migrations` table tracks migration history and SQLite's
`user_version` rejects newer, unsupported schemas. Migrations run inside
a transaction; job + page checkpoints are also transactional.

SQLite uses WAL journaling for file-backed databases, prepared statements
for all values, foreign keys, and a 5-second busy timeout. The database
file is created under a directory with restrictive permissions and the
SQLite file is mode 0600 on Linux. Store the file on a local writable
filesystem, not a network-mounted volume.

## Use with crawl jobs

The persist adapter saves the queued job immediately, then checkpoints
progress at each state transition. Successful pages are parsed to
Markdown and persisted as they're processed. **No public crawl API is
exposed yet.** The caller still MUST supply real robots.txt/site
permission checks, a shared rate limiter, and an SSRF-safe HTTP loader.

```ts
import { SqliteCrawlStore, createPersistedCrawlJob } from "@dox-scraper/storage";

const store = new SqliteCrawlStore({ path: "./storage/dox.sqlite" });
const job = createPersistedCrawlJob(store, {
  seedUrl: "https://example.com/",
  maxPages: 10,
  maxDepth: 2,
  canFetch: checkRobotsAndSitePermission,
  acquirePermit: (url, signal) => sharedLimiter.acquire(url, signal),
  loadPage: safeHttpPageLoader,
});

const snapshot = await job.start();
console.log(snapshot.id, snapshot.state);
console.log(store.getJob(snapshot.id));
console.log(store.getPageResult(snapshot.id, snapshot.seedUrl));
store.close();
```

`checkRobotsAndSitePermission`, `sharedLimiter` and
`safeHttpPageLoader` above are integration placeholders, not
implemented in this example. Never substitute `canFetch: async () => true`
for a real site-policy implementation.

## Restart recovery

Jobs and results are durable. On **single-owner application startup**,
call `store.recoverInterruptedJobs()` to mark any `queued`/`running`
jobs as failed with `PROCESS_RESTARTED`, including pending pages.
The method is idempotent and makes no network requests; it does not
automatically resume a crawl without rechecking site permissions.
It must not run while another process is actively writing crawl jobs.

```ts
const store = new SqliteCrawlStore({ path: "./storage/dox.sqlite" });
const recovered = store.recoverInterruptedJobs();
console.log({ recovered });
```

## Resource limits and security

Default result storage cap: **256 KiB** of UTF-8 Markdown, text and
metadata per page (configurable from 1 KiB to 2 MiB). Each persisted
cached HTML body is limited to 2 MiB by default, with 100 entries and
32 MiB total cache body budget. These limits are enforced before writes.
The store rejects oversized results, uses atomic upserts and foreign keys,
and supports bounded listing, deletion, and cache expiration/eviction.

Stored content is **not encrypted**. Only use this for permitted public
webpages; do not persist session cookies, credentials or personal data.
Place the database under a private filesystem path with routine backups.
WAL means the `.sqlite-wal` and `.sqlite-shm` sidecar files belong with
the database during active use; coordinate backups rather than copying
only the main database file while writes are occurring.

`cache_entries` is an optional repository for future persistent caching.
It is **not yet wired into the existing in-memory API ResponseCache**,
and is not a source of authenticated responses. Callers must still honor
robots.txt, caching permissions and variant-specific keys. The current
single-page scrape API continues to use its existing in-memory cache.

`node:sqlite` is still marked release-candidate in Node.js 24.
The synchronous driver is appropriate for the single-process Raspberry
Pi MVP and low-volume checkpoint writes; move heavy writes to a dedicated
worker if event-loop blocking becomes measurable.

## Local checks

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Integration tests create real SQLite files in temporary directories,
close and reopen them, exercise versioned migrations, status updates,
Markdown fingerprints, result size limits, foreign keys, cache eviction
and interrupted-job recovery. They do not contact external websites.
