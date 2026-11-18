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

## Development

The repository is being initialized. Follow the GitHub issues in milestone order, starting with the foundation and single-page scraper MVP.

## License

License to be selected before public distribution.
