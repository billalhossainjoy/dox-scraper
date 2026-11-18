# Optional Playwright browser rendering — Issue #15

The Dox Scraper API uses HTTP + Cheerio by default. It does **not**
automatically launch a browser when parsing a webpage. A caller must
explicitly request `"render": "browser"`, and the operator must enable
browser rendering for that exact website origin.

## Lightweight Raspberry Pi design

- Uses `playwright-core`, which installs the TypeScript/Node bindings
  **without downloading Chromium** during pnpm install.
- Uses a **system-installed Chromium executable**. ARM64 compatibility
  depends on your Raspberry Pi OS/Chromium package version.
- At most **one active browser render per API process**; new browser jobs
  fail with `BROWSER_BUSY` rather than building up a memory-heavy queue.
- Creates a fresh headless, sandboxed Chromium browser/context/page for
  each render, and closes all three in finally.
- Default browser timeout is 15 seconds (maximum 30 seconds), navigation
  timeout is 10 seconds, and the post-DOM settle interval is 400 ms.
  Input and rendered HTML are capped at 2 MiB.

## Security and controlled rollout

Browser rendering has a larger attack surface than HTTP-only scraping.
Do **not** enable it on an internet-exposed API or without network
isolation/firewall egress rules preventing the Chromium process or
container from contacting internal networks, loopback services,
cloud metadata endpoints and private subnets.

The browser receives the already-fetched HTML from the SSRF-protected
Node fetcher. Playwright **fulfills exactly one navigation document
from that HTML**. The route handler aborts *all other browser requests*;
it does not call `route.continue()`, `route.fetch()` or access resources
through Playwright. Service workers are blocked and WebSockets are
closed, with downloads disabled and Chromium sandboxing enabled.

These application controls are defense in depth, **not a guarantee**
against all browser-originated traffic: deploy a separate egress-isolated
browser worker/container as an additional security boundary. We do not
provide a public multi-page browser crawler yet.

Because every external script, stylesheet, XHR and other subresource is
blocked, this MVP supports pages with meaningful **inline JavaScript**
but does **not yet hydrate most large React/Next.js SPAs** that need
external JavaScript bundles. Supporting them will require a separate
SSRF-safe, site-permission-gated, per-domain-throttled subresource proxy.

## Enable for a trusted origin (local development only)

Install Chromium on the host/container from your OS package manager and
verify the executable path. Do not use `--no-sandbox` or run Chromium
as root. Place the browser in a network-restricted environment first.

Then update the root `.env`:

```dotenv
DOX_ENABLE_BROWSER_RENDERING=true
DOX_BROWSER_ALLOWED_ORIGINS=https://example.com
DOX_CHROMIUM_PATH=/usr/bin/chromium
```

The allowlist contains exact origins (scheme, hostname and port).
Do not use wildcards. Both the original requested URL and the final
URL after HTTP redirects must be allowlisted. This configuration is a
deployment trust decision: the API does not verify robots.txt rules on
its own, so use only sites you are explicitly permitted to process.

A request opts in per call:

```bash
curl -sS http://127.0.0.1:3000/v1/scrape \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
    "url": "https://example.com/dynamic",
    "options": { "render": "browser", "timeoutMs": 15000 }
  }'
```

The result includes `renderMode: "browser"` and Markdown extracted
from the rendered document. Normal requests omit `renderMode` and
continue using the faster HTTP-only pipeline.

When disabled, a browser request returns `503 BROWSER_DISABLED`
**without making an HTTP request to the target**; disallowed origins
return `403 BROWSER_NOT_ALLOWED`.

## Testing

CI runs offline, mocked Chromium-routing tests and API pipeline tests
without installing a browser. For a real, explicitly opt-in smoke test,
set `DOX_CHROMIUM_PATH` and run:

```bash
pnpm build
DOX_CHROMIUM_PATH=/usr/bin/chromium \
  pnpm --filter @dox-scraper/browser exec vitest run src/smoke.test.ts
```

The smoke fixture is a fully synthetic HTML document with inline
JavaScript, supplied through route fulfillment. It does not scrape
a real third-party website. A working system Chromium and compatible
Linux dependencies are needed; CI does not claim this hardware test
has passed.
