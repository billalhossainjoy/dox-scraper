# Response cache and content fingerprints — Issue #13

Dox Scraper now includes `@dox-scraper/cache`, a bounded **in-memory**
cache for public HTML responses. The Hono `POST /v1/scrape` endpoint uses
one `ResponseCache` instance per API process.

## Behavior

- First successful `200` HTML fetch: store a copy of the body, validators
  (`ETag`, `Last-Modified`) and a SHA-256 fingerprint of its UTF-8 HTML.
- Fresh cache hit: reuse the body with **no network request**.
- Expired cached page: send `If-None-Match` and/or `If-Modified-Since`
  when available and safe for the original URL.
- HTTP `304 Not Modified`: reuse the previously stored body; report the
  existing SHA-256 fingerprint.
- HTTP `200` after expiration: compute a new fingerprint and indicate
  whether the stored page changed.
- HTTP `429` or other non-200 responses: do **not** cache the error.
  Do not serve stale HTML by default.
- Cache-Control `no-store`/`private` or any `Vary` header: bypass storage.
  Cache-Control `no-cache` requires revalidation on the next request.
  `max-age` can shorten but never extend the configured local TTL.
- Do not forward conditional validator headers after HTTP redirects.
- Requests for smaller `maxBytes` than the cached body fail with
  `RESPONSE_TOO_LARGE` instead of bypassing the user's limit.

## Default memory budget

| Setting | Default |
| --- | ---: |
| Cache freshness | 5 minutes |
| Cached entries | 100 |
| Aggregate stored HTML | 32 MiB |
| Single stored HTML body | 2 MiB |

The cache evicts least-recently-used entries when these limits are reached.
It is per Node.js process; entries disappear on process restart. SQLite
persistence and shared worker caching belong in a later issue.

## API output

An authenticated `POST /v1/scrape` response includes optional cache
metadata within `data.cache`. Example:

```json
{
  "status": "HIT",
  "contentSha256": "08c...64-character-sha256-hex...",
  "changed": false,
  "cachedAt": "2026-11-18T11:00:00.000Z",
  "checkedAt": "2026-11-18T11:00:01.000Z"
}
```

Status values: `MISS`, `HIT`, `NOT_MODIFIED`, `REFRESHED`, `BYPASS`.
The `contentSha256` is the hash of the **raw HTML body**, not the
extracted Markdown. `changed=true` means the latest full HTML fetch
differs from the previous cached HTML. `cachedAt` is the original
download time, while `checkedAt` records the latest cache check.

This cache is intended only for unauthenticated public pages. It does not
send cookies or Authorization headers and never caches responses declaring
themselves private or no-store. Do not use it for authenticated personal
pages without adding isolation and representation-aware keys.

**Caching does not implement robots.txt access checks, site permissions,
or per-domain pacing.** Do not expose the scraper as an unrestricted public
service until those controls are wired in and validated.
