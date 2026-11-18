# Dox Scraper

A self-hosted, resource-conscious web scraping and crawling service designed to run on a Raspberry Pi 4 (8 GB RAM).

## Project goals

- Scrape a single webpage and return clean Markdown and metadata.
- Crawl permitted pages within explicit scope, depth, and page limits.
- Discover URLs from links and sitemaps.
- Use HTTP fetching by default and optional browser rendering only when required.
- Apply per-domain throttling, Retry-After handling, bounded retries, and caching.
- Expose functionality through a REST API and, later, an MCP server.
- Run self-hosted with Docker Compose and Cloudflare Tunnel.

## MVP scope

The first release focuses on:

1. TypeScript + pnpm workspace.
2. Hono API with a health endpoint.
3. Safe HTTP fetcher.
4. HTML extraction with Cheerio.
5. HTML-to-Markdown conversion.
6. `POST /v1/scrape` with validation and tests.

Website crawling, SQLite persistence, Playwright, MCP, and production deployment follow after the single-page scraper works.

## Planned stack

- Node.js + TypeScript
- pnpm workspaces
- Hono
- Crawlee (for crawl orchestration)
- Cheerio
- Playwright (optional fallback)
- SQLite
- Zod
- MCP TypeScript SDK
- Docker Compose

## Safety principles

- Respect website terms, robots.txt directives, and access restrictions.
- Do not bypass CAPTCHAs, authentication, or explicit bot protections.
- Apply conservative per-domain request limits and honor `Retry-After`.
- Validate URLs, DNS resolutions, and every redirect to prevent SSRF.
- Block loopback, private, link-local, reserved, and cloud metadata destinations.
- Keep credentials, databases, and worker ports private.

## Local development

Requirements: Node.js 24.15+ and pnpm 12.18.0.

```bash
pnpm install
cp .env.example .env
# Edit .env and replace DOX_SCRAPER_API_KEY with a securely generated key.
# For example, generate a value using: openssl rand -hex 32
pnpm dev
```

The development command builds the internal packages before launching the Hono API.
The local server listens on `127.0.0.1:3000` by default.

### Scrape a public HTML page

```bash
curl -sS http://127.0.0.1:3000/v1/scrape \
  -H "Authorization: Bearer YOUR_KEY_FROM_DOT_ENV" \
  -H "Content-Type: application/json" \
  --data '{"url":"https://example.com","options":{"timeoutMs":15000,"maxBytes":1048576,"maxRedirects":3,"maxCharacters":50000}}'
```

The endpoint returns `success: true` with the requested URL, final URL,
HTTP status, page title, description, canonical URL, language, headings, links,
plain text, Markdown, and fetch timestamp. Failure responses contain `error.code`
and `error.message`.

Useful endpoints:

- `GET /health` — health status, no API key
- `GET /openapi.json` — OpenAPI specification, no API key
- `POST /v1/scrape` — authenticated single-page scraping

### Quality checks

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

### Security and limits

The API requires `DOX_SCRAPER_API_KEY` and permits at most two simultaneous
scrape requests per API process. Request bodies are limited to 16 KiB;
individual target responses are limited to at most 2 MiB. The fetcher blocks
local/private/reserved IP destinations and validates each redirect.
Only HTML and XHTML responses are converted to Markdown.

**This is not an unrestricted public crawler service.** The optional, allowlisted crawl API enforces robots.txt and per-domain pacing, but there is no distributed crawler coordinator. Browser rendering is disabled in the Pi Compose deployment. Keep the API bound to localhost and publish it only through a correctly configured Cloudflare Access-protected tunnel with an independent API bearer token.
Respect each target website's terms and access restrictions.

## License

License to be selected before public distribution.

## Response caching

The `/v1/scrape` API caches public HTML in a bounded per-process LRU:
5-minute default freshness, 100 entries, 32 MiB total. It supports ETag
and Last-Modified conditional GETs and returns SHA-256 fingerprint metadata
in `data.cache`. Private/no-store responses are never cached.

See [docs/CACHE.md](docs/CACHE.md) for limits and policy.

## SSRF and safe network destinations

The HTTP fetcher rejects local, private and special-purpose IPv4/IPv6
addresses (including cloud metadata endpoints), validates DNS answers at
connection time and checks each redirect destination. It supports abort
signals and an overall timeout across redirects. For crawler safety
details see [docs/CRAWLING.md](docs/CRAWLING.md).

## Optional browser rendering

A Playwright Chromium renderer is available only when an authenticated
request explicitly supplies `"options": { "render": "browser" }`
and the operator opts in with a Chromium path and an exact origin allowlist.
It is disabled by default, limits browser work to one active render per
process, and blocks external subresources. Browser execution requires
a **network-isolated** worker/container before enabling it.

See [docs/BROWSER.md](docs/BROWSER.md) for configuration, limitations,
security boundaries, and optional hardware smoke tests.

## Durable crawl storage

The `@dox-scraper/storage` workspace package persists crawl jobs,
discovered URLs, extracted Markdown and optional public HTML cache
entries in **SQLite**, using Node.js 24's built-in driver. It includes
versioned migrations, WAL mode, size limits and restart recovery.

The `createPersistedCrawlJob()` adapter checkpoints a job as pages
complete. The authenticated REST crawl endpoints are available when explicitly enabled; `/v1/scrape` continues to use an in-memory response cache.

See [docs/STORAGE.md](docs/STORAGE.md) for usage, data model, and backup
and security considerations.

## Opt-in crawl job API

Authenticated, persistent crawl jobs can be created, polled, paginated
and cancelled through `/v1/crawl`, `/v1/crawl/:id` and
`/v1/crawl/:id/results`. Crawling is **disabled by default** and
requires explicit operator origin allowlists, robots.txt access checks,
a shared rate limiter and SQLite persistence.

See [docs/CRAWL_API.md](docs/CRAWL_API.md) for setup, endpoint details,
owner-scoped results, safety controls and restart behavior.

## MCP tools for AI clients

The new `apps/mcp` app exposes **scrape_url**, **map_url**,
**crawl_url** and **get_crawl_status** over local MCP stdio.
Every tool delegates to the existing bearer-authenticated Hono REST API
rather than creating an unrestricted scraper. The tool host must
supply `DOX_SCRAPER_API_KEY` and can connect to a trusted local or
HTTPS REST endpoint via `DOX_MCP_API_URL`.

See [docs/MCP.md](docs/MCP.md) for stdio client configuration, security
and the scope of the four tools.

## Raspberry Pi Docker Compose deployment

A private `compose.yaml` builds the **API** and a **network-isolated
SQLite maintenance worker** with Node.js 24. Both containers are
ARM64/AMD64 compatible, have health checks, resource limits and a
shared persistent named Docker volume. The API binds to the Pi
host's loopback interface by default.

```bash
cp .env.example .env
# Replace the example DOX_SCRAPER_API_KEY with a freshly generated secret.
docker compose up --build -d
curl http://127.0.0.1:3000/health
```

Crawl execution currently happens inside the API, **not** the maintenance
worker. Browser rendering remains disabled. See
[docs/DEPLOY-PI.md](docs/DEPLOY-PI.md) for full setup,
SSD and backup guidance and security limitations.

## Secure Cloudflare Tunnel (opt-in)

The Raspberry Pi deployment can use an **existing Cloudflare Tunnel**
to publish exactly one HTTPS hostname, protected by
**Cloudflare Access service tokens** and a separate Dox Scraper
API bearer key. The application adds optional hostname
verification, `no-store` security headers, and structured logs
without query strings or credential values.

The repository **does not modify your live Cloudflare account**.
Follow [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md) to add the
published hostname and Access policy, then run the
`scripts/verify-tunnel.mjs` two-layer authentication smoke test
before allowing remote traffic. The API and SQLite worker remain
private, and inbound ports stay closed.
