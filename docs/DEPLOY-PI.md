# Deploy Dox Scraper on a Raspberry Pi 4 (8 GB) — Issue #19

This deployment uses **Docker Compose** with a multi-stage, multi-target
Dockerfile and official Node.js 24 Debian Linux images. It works on
supported `linux/arm64` machines (64-bit Raspberry Pi OS / Ubuntu)
and can also run on `linux/amd64`.

The default stack is private, lightweight, and designed for one
Raspberry Pi and one SQLite database. It does **not** make a public
scraping service available over the internet.

## Services

| Service | Work | Resources | Network |
| --- | --- | --- | --- |
| `api` | Hono HTTP API and **in-process crawl job executor** | 768 MiB RAM, 1 CPU | Host loopback port 3000 only |
| `worker` | Expired SQLite cache cleanup every 60 seconds and heartbeat | 192 MiB RAM, 0.25 CPU | **No network** |

The maintenance worker does **not** process crawl jobs. Crawl jobs
currently run in the API's single-process `CrawlManager`. That
manager is required for its existing robots.txt and rate-limit
policies and uses one owner for crash recovery. A future independent
crawl worker will require a durable lease/queue protocol and a
shared rate-limit coordinator. Do **not** start two API replicas
against one SQLite file.

Both services use non-root UID 1000, a read-only filesystem, reduced
Linux capabilities, `no-new-privileges`, PID caps, memory/CPU limits,
bounded container logs and Docker restart policies.

The browser renderer is **always disabled** in this Compose stack.
A network-isolated Chromium worker is required before you can
safely enable it.

## 1. Prepare a 64-bit Raspberry Pi

Verify architecture:

```bash
uname -m
```

Expect `aarch64` (64-bit). Install Docker Engine and Docker
Compose Plugin from official supported packages for your Pi OS.
Verify:

```bash
docker version
docker compose version
```

Use an **SSD** rather than an SD card for the Docker data root or the
named SQLite volume if you expect regular scraping. Frequent WAL writes
can accelerate SD-card wear. Back up the SQLite data regularly.

## 2. Configure the deployment

From the repository root:

```bash
cp .env.example .env
openssl rand -hex 32
```

Replace the placeholder in the untracked `.env` file with the
generated secret:

```dotenv
DOX_SCRAPER_API_KEY=YOUR_GENERATED_LONG_RANDOM_SECRET
DOX_BIND_PORT=3000
DOX_ENABLE_CRAWL_API=false
DOX_CRAWL_ALLOWED_ORIGINS=
DOX_WORKER_INTERVAL_SECONDS=60
```

**Do not commit `.env` or paste the secret into source, issues or
MCP tool prompts.** Compose uses this environment for substitution,
not an `env_file` override. The API receives only the settings
explicitly listed in `compose.yaml`.

For an approved, private crawl use:

```dotenv
DOX_ENABLE_CRAWL_API=true
DOX_CRAWL_ALLOWED_ORIGINS=https://example.com
```

Crawling remains bounded and subject to robots.txt Allow/Disallow
and server pacing. It does not bypass access restrictions. Only
include origins you have permission to crawl.

## 3. Build and start

```bash
docker compose config --quiet
docker compose up --build --detach
docker compose ps
docker compose logs --tail=100 api worker
```

On a Pi, Docker builds natively for ARM64; no separate ARM image
or platform emulation flag is needed. The Dockerfile uses a pinned
**multi-architecture manifest-index digest** for the official
`node:24-bookworm-slim` image, verified to contain both Linux AMD64
and Linux ARM64. The **build and runtime stages both target the
deployment architecture** so optional native Node dependencies are
not accidentally copied from an x86 build into the Pi image.

On an amd64 development host, you can validate ARM64 output with
Docker Buildx/QEMU (slower than a native Pi build):

```bash
docker buildx build --platform linux/arm64 \
  --file docker/Dockerfile --target api .
docker buildx build --platform linux/arm64 \
  --file docker/Dockerfile --target worker .
```

The Dockerfile uses Node 24 to meet `node:sqlite` requirements,
and commits a `pnpm-lock.yaml` generated with pnpm 12.18.0.
Docker and CI use `pnpm install --frozen-lockfile`. The base image
reference contains both a readable tag and a **fixed SHA-256 digest**.
Docker resolves the digest, not the mutable tag, for all build stages.

Verify the pinned multi-architecture registry manifest from the repository
root before release:

```bash
bash scripts/verify-docker-base.sh
```

The script checks the exact official Docker Hub image, compares its digest
to the Dockerfile, and confirms that the index contains Linux AMD64 and
Linux ARM64. It does not prove a full ARM64 build works on your own Pi;
run `docker compose up --build -d` and check architecture and health
on the actual Pi before launch.

To upgrade Node or apply security updates, **intentionally** select an
updated digest from the registry, update the Dockerfile, run the
verification script and rebuild/test both images in CI. A digest pin
prevents surprise upgrades: it also means security patches require
explicit maintenance.

## 4. Check the API and worker health

From the Pi host:

```bash
curl --fail http://127.0.0.1:3000/health
docker compose ps
docker compose exec worker node apps/worker/dist/health.js
```

The API healthcheck checks `GET /health` inside the container.
The maintenance worker writes an atomic heartbeat after each
successful SQLite cache prune; its Docker healthcheck rejects
missing/stale heartbeats. The worker exits on a fatal database error,
so `restart: unless-stopped` can restart it.

HTTP is bound only to `127.0.0.1` on the Pi host. Another
LAN device cannot reach the API via the Pi's private LAN IP.
Cloudflare Tunnel authentication, route restrictions and secure
external hostname configuration are handled in **Issue #20**.
Do not simply replace the loopback binding with `0.0.0.0`
to expose the API to the internet.

## 5. Persistent SQLite storage

The named Docker volume `dox-scraper_dox_data` is mounted at
`/data` in both containers; the SQLite file is
`/data/dox.sqlite`. It survives:

```bash
docker compose up -d --force-recreate
docker compose down
docker compose up -d
```

**Avoid `docker compose down --volumes`** unless you intend to
delete the named data volume. Do not use bind mounts into
root-owned directories without ensuring UID 1000 can write them.
The image prepares `/data` for the non-root Node user.

To make an online backup, use SQLite's backup facility or
`VACUUM INTO` from a quiescent/controlled database connection.
For a simple cold backup, stop the services first and copy the
volume's **database and WAL/SHM files together** (if present).
Do not copy just the main SQLite file while live writes are in
progress; WAL transactions can be missed.

Example cold backup into a directory on the Pi:

```bash
mkdir -p ./backups
docker compose down
docker run --rm \
  -v dox-scraper_dox_data:/source:ro \
  -v "$PWD/backups:/backup" \
  alpine:3.21 sh -c 'cd /source && tar czf /backup/dox-sqlite-backup.tgz .'
docker compose up -d
```

If you choose to run this with an SSD, ensure Docker's volume
storage path is actually on the SSD. The Compose volume name
itself does not guarantee storage media.

## 6. Operational limits and monitoring

- API: max **768 MiB**, 1 CPU, 128 PIDs; worker: max **192 MiB**,
  0.25 CPU, 48 PIDs
- Worker: **no network access**; only prunes expired persistent cache
  entries and updates a heartbeat
- API: **one active crawl job**, max 50 pages and depth 3 when
  crawling is explicitly enabled
- Database: SQLite WAL, foreign keys, transactional updates and
  migration tracking
- Container logs rotate (3 files of up to 10 MiB for API, 5 MiB
  for worker) instead of expanding indefinitely
- Browser rendering is disabled in this image

For updates:

```bash
git pull --ff-only
docker compose up --build --detach
docker compose ps
```

Check image architecture with:

```bash
docker image inspect dox-scraper-api:local --format '{{.Architecture}}'
```

Expect `arm64` on Raspberry Pi OS 64-bit. Rebuilding after source
changes does not delete the SQLite volume.

## Limitations

The Docker Compose configuration is intended for a single trusted
operator. It is **not a multi-tenant production crawler** and does
not automatically orchestrate horizontal workers. The database cache
table is still independent of the API's in-memory response cache,
so the maintenance worker may have little to prune until a
persistent cache integration is added.

Docker startup and **negative production-secret checks** are validated in CI on Linux amd64. ARM64 builds
are possible using the multi-platform Node image, but actual Pi
hardware, SSD performance, and Cloudflare Tunnel are separate
deployment checks.

## Route through your existing Cloudflare Tunnel

After verifying that both Compose services are healthy, follow
[CLOUDFLARE.md](CLOUDFLARE.md) to attach a dedicated hostname to
the **existing** tunnel, configure Cloudflare Access with Service
Auth, and verify the independent Dox Scraper bearer authentication.
The tunnel connector must be able to reach the Pi's **host
loopback** listener, not another machine's `127.0.0.1`. Do not
change Compose to a public TCP bind.

## Production preflight (release hardening)

The API now checks deployment configuration **before opening port 3000**
when `NODE_ENV=production` (as set by Compose).

- `DOX_SCRAPER_API_KEY` must not be a placeholder, obviously weak,
  too short, control-character-containing or repetitive value.
  Generate a fresh one using `openssl rand -hex 32` on the Pi.
  The shape check is not a substitute for using a cryptographically
  secure generator.
- `DOX_ENABLE_CRAWL_API`, `DOX_ENABLE_BROWSER_RENDERING` and
  `DOX_HTTP_ACCESS_LOGS` must be `true` or `false` if set.
- If the crawl API is enabled, an explicit comma-separated list
  of exact HTTP(S) origins is required.
- If provided, `DOX_PUBLIC_HOSTNAME` must be a lowercase DNS hostname
  without wildcard, scheme or port.
- Production Compose does not isolate Chromium, so setting
  `DOX_ENABLE_BROWSER_RENDERING=true` fails startup.

Preflight errors identify **which configuration variable** needs
attention but never print its value. The production Docker CI test
verifies rejection of the original `.env.example` placeholder and
other weak settings. Development scripts can still use short
temporary API keys for local/offline testing.

Use [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) before enabling
remote access.

## ARM64 CI and safe online SQLite backups

The repository additionally tests real ARM64 images under QEMU in
GitHub Actions, including the API, maintenance worker and `node:sqlite`.
It does **not** substitute for a native Pi hardware test.

A new backup command can take a consistent SQLite snapshot without
stopping the running API, and validates an isolated restored copy
before publishing the output. It refuses to overwrite previous backups.

See [ARM64-BACKUP.md](ARM64-BACKUP.md) for the exact Pi commands,
expected disk requirements, safety guards and remaining restore
rehearsal steps.

## Read-only host preflight

After starting the Pi containers, run from the repository root on the
**real Raspberry Pi**:

```bash
node scripts/pi-preflight.mjs
```

This does not require a Cloudflare service token or the API bearer
token as CLI arguments. It examines only local Docker Compose and
container settings, local API health, image architecture and SQLite
volume mounts, without restarting or mutating them.

It does require Node.js 24 on the host, permission to run Docker,
and a configured Compose `.env` file. The script will **never print**
the resolved Compose JSON or raw Docker inspect results because they
can contain environment secrets. See
[PI-PREFLIGHT.md](PI-PREFLIGHT.md) for the complete check list.
