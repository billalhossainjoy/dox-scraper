# Dox Scraper MCP server — Issue #18

The `@dox-scraper/mcp` app uses the official **MCP TypeScript SDK v2**
and the **stdio** transport. Compatible MCP hosts can launch it as a
local subprocess and discover/call its tools.

## Architecture and safety

```text
AI client / MCP host
         |
      MCP stdio
         |
  apps/mcp (local subprocess)
         |
  Bearer token, same REST API
         |
  Dox Scraper Hono API  ->  SSRF-hardened fetcher / crawl manager
                                    |
                              SQLite storage
```

MCP **does not fetch target websites directly**. Each tool calls the
existing protected REST API, which enforces the bearer token and
scrape/crawl resource limits. The optional crawl API is disabled by
default and uses explicit exact-origin allowlisting, robots.txt access
rules and per-domain rate pacing.

There is **no remote MCP HTTP listener** in this MVP. Stdio allows
a compatible desktop/CLI MCP host to spawn this trusted local process.
To connect ChatGPT's remotely hosted MCP integration directly, a future
authenticated Streamable HTTP endpoint would be needed; do **not**
open a raw unauthenticated MCP HTTP endpoint through Cloudflare Tunnel.

## Tool list

| Tool | Action | REST endpoint |
|---|---|---|
| `scrape_url` | Extract one page as Markdown, max 60k characters | `POST /v1/scrape` |
| `map_url` | Map up to 100 same-origin links from **one page** | `POST /v1/scrape` |
| `crawl_url` | Submit a bounded async crawl (1–50 pages, depth 0–3) | `POST /v1/crawl` |
| `get_crawl_status` | Poll a credential-owned crawl job | `GET /v1/crawl/:id` |

`map_url` is **not a complete site map**: it returns deduplicated
same-origin links from the downloaded HTML and does not follow links,
read `sitemap.xml` or execute browser JavaScript. It discards
non-HTML assets and external URLs. `scrape_url` is HTTP-only by design;
Playwright cannot be enabled implicitly by an MCP model argument.

The MCP app delegates all crawl decisions to the REST API. If the REST
crawler is disabled, not authorized for a domain, or blocked by
robots.txt, the MCP tool returns that error instead of bypassing it.
The standalone `/v1/scrape` route currently performs its existing
SSRF-safe, bounded single-page fetching but is **not a robots.txt
crawler** and does not provide full website crawl permission enforcement.

## Run locally

Start the Hono API separately:

```bash
pnpm install
pnpm build
# Set the API bearer secret in root .env, then start:
pnpm dev
```

From the repo root, the MCP server can be started with:

```bash
DOX_SCRAPER_API_KEY="YOUR_SAME_REST_API_KEY" \
DOX_MCP_API_URL="http://127.0.0.1:3000" \
  pnpm --filter @dox-scraper/mcp start
```

No output is printed to stdout except MCP protocol messages. Errors
and diagnostics are printed to stderr. Do not run two copies of the
REST API against the same live SQLite database.

## MCP host configuration

Use the **absolute path** to the compiled entry point. For a local
MCP client such as a desktop host or CLI tool, adapt this example
to the host's configuration format:

```json
{
  "mcpServers": {
    "dox-scraper": {
      "command": "node",
      "args": ["/absolute/path/to/dox-scraper/apps/mcp/dist/index.js"],
      "env": {
        "DOX_MCP_API_URL": "http://127.0.0.1:3000",
        "DOX_SCRAPER_API_KEY": "REPLACE_WITH_YOUR_REST_API_KEY"
      }
    }
  }
}
```

**Security:** The key stays in the MCP host process environment; tools
cannot read it or change the REST API destination. Never put real keys
into tracked files or model prompts. The MCP API URL must be a plain
origin. Local `http://127.0.0.1`, `http://localhost` and `http://[::1]`
are supported; remote connections require HTTPS.

`DOX_MCP_API_URL` defaults to `http://127.0.0.1:3000`.
The REST API must already be running and use the same token.
The MCP proxy does not follow redirects, caps API response bodies at
1 MiB by default, and applies an overall 30-second API request
timeout. MCP tool inputs are validated and resource-limited.

`crawl_url` additionally requires the operator to configure the Hono
API's `DOX_ENABLE_CRAWL_API=true` and an exact origin in
`DOX_CRAWL_ALLOWED_ORIGINS`. See [CRAWL_API.md](CRAWL_API.md).

## Tests

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

The offline MCP integration test creates a real MCP `Client` and
`McpServer` connected through a linked in-memory protocol transport.
It verifies the four tool names, validated arguments, responses,
tool errors, and REST delegation. A separate test exercises REST
headers, authentication forwarding, response caps and redirect
blocking. CI does not require a running webpage, internet connection
or Raspberry Pi, and does not claim to have deployed MCP to ChatGPT.
