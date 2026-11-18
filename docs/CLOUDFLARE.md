# Secure Cloudflare Tunnel deployment — Issue #20

Dox Scraper is designed for a **private, single-operator Raspberry Pi**.
Cloudflare Tunnel can publish a single HTTPS hostname without opening
inbound router ports. Use **Cloudflare Access** in front of that
hostname, *and* keep the independent API bearer token enabled.

**Important:** This repository configures and tests the API side, but
it does **not** create a DNS record, edit your existing Cloudflare
Tunnel, create Access policies, or deploy anything to your account.
You must apply the steps below to your own existing tunnel and verify
the policy before relying on a remote URL.

## Intended architecture

```text
Authorized AI/CLI client
  | HTTPS, Cloudflare Access service token, API Bearer token
  v
Cloudflare Access application: scraper.YOUR_DOMAIN
  | only after Service Auth policy grants access
  v
Cloudflare Tunnel (outbound cloudflared connector on the Pi host)
  | http://127.0.0.1:3000
  v
Docker Compose API -> bounded, policy-aware scraper/crawler
  |                 -> SQLite named volume (/data/dox.sqlite)
  + internal SQLite maintenance worker: no network or public port
```

The existing Compose file publishes only
`127.0.0.1:3000:3000` on the Pi. The database and worker have
**no public listener**. The browser renderer remains disabled.

## 1. Prepare the Raspberry Pi API

Start with [DEPLOY-PI.md](DEPLOY-PI.md). Ensure
`docker compose ps` reports a healthy API and worker.

Use a dedicated hostname such as
`scraper.YOUR_DOMAIN` (replace the placeholder with a
real subdomain in a Cloudflare-managed DNS zone).

Edit the local **untracked** `.env` on the Pi:

```dotenv
DOX_SCRAPER_API_KEY=GENERATE_A_NEW_RANDOM_SECRET
DOX_PUBLIC_HOSTNAME=scraper.YOUR_DOMAIN
DOX_HTTP_ACCESS_LOGS=true
DOX_ENABLE_CRAWL_API=false
DOX_CRAWL_ALLOWED_ORIGINS=
DOX_BIND_PORT=3000
```

Use a lowercase real DNS hostname with no scheme, wildcard or port
for `DOX_PUBLIC_HOSTNAME`. It is an **additional Host-header check**,
not authentication. The API still accepts loopback Host headers for
local maintenance and health checks.

Generate a secret with `openssl rand -hex 32`, and use:

```bash
chmod 600 .env
docker compose up --build -d
curl --fail http://127.0.0.1:3000/health
```

**Do not publish the key in Git, Compose YAML, examples, GitHub
Actions variables, issue descriptions, or model prompts.** Docker
container environment variables remain visible to users with Docker
daemon access, so limit Pi/Docker group membership. Keep
Cloudflare Tunnel credentials outside the application repository.

## 2. Route a single hostname through your EXISTING tunnel

Go to the Cloudflare dashboard, open **Networking > Tunnels**,
and select the **existing remotely-managed tunnel** whose
`cloudflared` connector is running on this Raspberry Pi.

In its published application routes, add an HTTP route:

| Setting | Value |
| --- | --- |
| Public hostname | `scraper.YOUR_DOMAIN` |
| Service type | HTTP |
| Service URL | `http://127.0.0.1:3000` |
| HTTP Host Header (origin setting) | `scraper.YOUR_DOMAIN` |
| Protect with Access | Enabled (after configuring Access) |

Create only this dedicated hostname; do not use a wildcard, and
do not expose any `/data`, SQLite, Docker daemon, worker, debug or
admin service.

**Connector location matters:** `127.0.0.1` is interpreted on
the machine/container **running cloudflared**, not the remote Pi.
These instructions require the existing tunnel connector to run on
the same Pi **host** as Docker Compose. If the existing tunnel is
running on a different home server, do **not** point that server's
loopback address at the Pi. Either use a correctly routed private
connection with separate authentication, or run the connector on
the Pi after carefully reviewing other routes and replicas. Do
not add a competing replica to a shared tunnel unless every
connector can reach the same published origin.

The tunnel preserves the Pi's closed inbound router ports.
Do not open `3000` on the router, bind Compose to `0.0.0.0`,
or set a public origin IP address.

Cloudflare Tunnel routing docs:
https://developers.cloudflare.com/tunnel/concepts/routing/

## 3. Require Cloudflare Access before origin routing

In **Cloudflare Zero Trust > Access > Applications**, create a
**Self-hosted** application matching
`scraper.YOUR_DOMAIN` (all paths, not just `/v1/*`).

Create a service token for automated use, then attach a
**Service Auth** policy that includes **only** that token.
Avoid `Bypass` policies and unauthenticated public routes. The
`/health` and `/openapi.json` routes must also be protected
at Cloudflare's edge.

Enable **Protect with Access** for the matching published tunnel
hostname. This lets `cloudflared` validate Access assertions
for that route; a tunnel by itself does not grant authentication.

Cloudflare Access Service Token clients send BOTH:

- `CF-Access-Client-Id: <service-token-client-id>`
- `CF-Access-Client-Secret: <service-token-client-secret>`

The Hono REST API **also requires** its own distinct
`Authorization: Bearer <DOX_SCRAPER_API_KEY>` on scrape/crawl
operations. One token never substitutes for the other.

Cloudflare documentation:
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/
- https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/

## 4. Verify remotely (WITHOUT scraping a website)

Store the **actual** Access service-token credentials locally
in your ignored `.env`, or use your secure secrets manager:

```dotenv
DOX_PUBLIC_URL=https://scraper.YOUR_DOMAIN
DOX_CF_ACCESS_CLIENT_ID=YOUR_ACCESS_CLIENT_ID
DOX_CF_ACCESS_CLIENT_SECRET=YOUR_ACCESS_CLIENT_SECRET
DOX_SCRAPER_API_KEY=YOUR_DIFFERENT_API_BEARER_KEY
```

On the machine where you run the verification:

```bash
node --env-file=.env scripts/verify-tunnel.mjs
```

The script performs **no remote target scraping**. It checks all
of these assertions in order:

1. `GET /health` **without** Access credentials is rejected.
2. `GET /health` **with** a valid Access service token reaches
   Dox Scraper.
3. `POST /v1/scrape` with Access but **no bearer** returns 401.
4. A **wrong bearer** still returns 401.
5. Both valid credentials reach the API request validator, which
   returns HTTP 400 for the intentionally empty `{}` payload
   with `Cache-Control: no-store`.

The tool never follows HTTP redirects or prints the token values.
It cannot prove that all possible firewall/WAF or service-to-service
paths are safe; use Cloudflare dashboard policy inspection as well.

## 5. MCP clients

For a local MCP client on the Pi, continue using the loopback URL
without Cloudflare headers:

```dotenv
DOX_MCP_API_URL=http://127.0.0.1:3000
DOX_SCRAPER_API_KEY=YOUR_API_KEY
```

For an MCP client on another machine reaching the Access-protected
HTTPS hostname, configure:

```dotenv
DOX_MCP_API_URL=https://scraper.YOUR_DOMAIN
DOX_SCRAPER_API_KEY=YOUR_API_KEY
DOX_CF_ACCESS_CLIENT_ID=YOUR_ACCESS_CLIENT_ID
DOX_CF_ACCESS_CLIENT_SECRET=YOUR_ACCESS_CLIENT_SECRET
```

The MCP proxy includes the two Access headers only when both are
present and the REST API URL uses HTTPS. Redirects remain disabled,
so credentials cannot be forwarded to a redirected hostname.
The MCP tool inputs cannot override the API origin or credentials.

The current MCP process still uses **local stdio**, not a public
remote MCP HTTP endpoint. A separately designed, authenticated
HTTP MCP transport would be required for remote MCP registration.

## 6. Request limits and operational logs

The API protects outgoing HTTP fetches against private-network
SSRF and redirects. Existing limits include:

- `POST /v1/scrape`: request body up to **16 KiB**;
  target HTML up to **2 MiB**; up to 2 concurrent scrape requests
- `POST /v1/crawl`: request body up to **4 KiB**;
  bounded jobs; one in-process active crawl by default
- Crawl rules: explicit origin allowlist, robots.txt checks and
  per-origin request pacing
- Docker resources: API 768 MiB / 1 CPU; maintenance worker
  192 MiB / 0.25 CPU

Add appropriate Cloudflare edge rules/rate limiting for your
traffic if your account permits them, and never use edge rate
limits instead of the crawler's own origin-side limits.

When `DOX_HTTP_ACCESS_LOGS=true`, the API emits minimal JSON
access events with: timestamp, method, **route template**, status
and duration. It deliberately omits URL query strings, URL
parameters, API keys, Access tokens, request/response bodies and
client IPs. Logs rotate under Docker Compose; avoid posting
raw logs if a future component introduces sensitive fields.

Response security headers include `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`
and `Referrer-Policy: no-referrer`.

## 7. SQLite backups, restore and secret rotation

**Stop both containers** when doing a simple offline backup,
and include WAL/SHM sidecars (if any). The named volume persists
when containers are recreated, but is deleted by
`docker compose down --volumes`.

```bash
mkdir -p backups
docker compose down
docker run --rm \
  -v dox-scraper_dox_data:/source:ro \
  -v "$PWD/backups:/backup" \
  alpine:3.21 sh -c 'cd /source && tar czf /backup/dox-backup.tgz .'
docker compose up -d
```

To restore a **trusted** archive after stopping the stack,
first back up the current database, then restore into the
empty/cleared destination volume:

```bash
docker compose down
docker run --rm \
  -v dox-scraper_dox_data:/target \
  -v "$PWD/backups:/backup:ro" \
  alpine:3.21 sh -c 'cd /target && tar xzf /backup/dox-backup.tgz'
docker compose up -d
```

Only restore archives you created and have verified. Do not use
tar archives from unknown sources. On restore, make sure the
database remains writable by the non-root container UID (1000).
Do not run backup/restore tools concurrently with live writers.

Rotate the **API bearer** separately from the **Access
service-token** and **tunnel connector credentials**. Bearer
rotation invalidates current requests and can make old crawl jobs
unavailable by credential ownership digest. Re-check Access
policies after token rotation. Keep backups encrypted off-device
and avoid putting database files into Git.

## 8. Deployment verification limitations

GitHub CI tests the host guard, redacted logging, app bearer
authentication, Compose container health and SQLite volume
persistence using **synthetic inputs**. The optional
`scripts/verify-tunnel.mjs` utility performs live checks only
when explicitly run with real deployment credentials. CI does
not configure or reach your Cloudflare account, issue DNS
records, prove the live Access policy or run a Raspberry Pi
hardware test.

**Only after both manual Cloudflare settings and a successful
live verification should you consider the remote endpoint
ready for permitted traffic.**
