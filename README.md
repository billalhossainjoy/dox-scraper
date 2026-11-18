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

Requirements: Node.js 24 and pnpm 12.18.0.

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

**This is not yet a public crawler service.** The MVP does not implement
robots.txt enforcement, per-domain pacing, persistent rate limiting, caching,
or browser rendering. Keep the API bound to localhost and do not expose
it publicly through Cloudflare Tunnel until those controls are added.
Respect each target website's terms and access restrictions.

## License

License to be selected before public distribution.
