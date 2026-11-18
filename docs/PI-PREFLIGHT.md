# Read-only Raspberry Pi deployment preflight — Issue #47

Run this diagnostic on the **actual Raspberry Pi host** after installing
Docker Compose and starting Dox Scraper. It verifies that the deployment
is configured for a private, single-operator environment. It does **not**
start, stop, alter, or restart any containers, update dependencies, query
outside your Pi, scrape sites, or write to SQLite.

## Prerequisites

You need Node.js 24 or newer installed **on the Pi host**, a 64-bit Linux
OS (`uname -m` should be `aarch64`), Docker Engine and the Compose plugin.
The shell account needs permission to query Docker. Treat access to the
Docker daemon as privileged.

From the checkout's root directory, configure `.env` and start services:

```bash
docker compose config --quiet
docker compose up --build --detach
docker compose ps
node scripts/pi-preflight.mjs
```

**Important:** The preflight script itself is read-only, but the
`docker compose up` command shown above starts/recreates containers.
If production is already running, skip `up` and simply run the
diagnostic. Do not paste your `.env` or Docker inspect output into
support tickets or public chats.

Exit code **0** means all local checks passed. Exit code **1** means
at least one check failed or Docker could not be inspected. An
unverified Cloudflare policy is always reported as a **warning**, not
as a false passing result.

## Checks

| Check | Requirement |
| --- | --- |
| Host architecture | `linux/arm64` (aarch64 Pi OS) |
| Compose API port | Exactly one `127.0.0.1:PORT:3000` published port |
| Worker Compose networking | `network_mode: none`; no published ports |
| Compose security | Both services read-only, drop all caps, no new privileges |
| Browser isolation | Chromium rendering explicitly disabled |
| Compose storage | Writable `/data` volume on both services |
| Container health | Both services running and Docker health status healthy |
| Runtime security | Non-root user, read-only, no privileges, bounded CPU/RAM |
| Runtime networking | API bound to loopback only, worker has no published port |
| Shared storage | Both containers use the same writable named `/data` volume |
| Image architecture | Both deployed images are ARM64 |
| Local health | Loopback `GET /health` returns Dox Scraper health JSON |
| API bearer enforcement | Loopback unauthenticated `POST /v1/scrape` returns 401 |
| Cloudflare | Warning: live Access/Tunnel policy not verified by this script |

The diagnostic uses read-only `docker compose config`, `ps`,
`docker inspect`, `docker image inspect`, and two minimal loopback
HTTP requests. It uses no Docker volume writes and never executes
code in the running containers.

Resolved Compose JSON can contain **the API key**. The script never
prints Compose output, Docker inspection output, environment values,
request bodies, tokens, volumes, host addresses, or detailed stack traces;
it displays only generic check IDs and remediation guidance.

## What this does NOT prove

The checks are a configuration snapshot, not a security audit or a
long-running hardware endurance test. They cannot confirm the true
strength of your API key, storage durability, backups, real hardware
thermal performance, the completeness of robots.txt permission checks,
or whether Cloudflare Access has been correctly deployed.

For **remote access verification**, once your existing tunnel and
Access Service Auth policy are configured, run separately:

```bash
node --env-file=.env scripts/verify-tunnel.mjs
```

That command deliberately checks both the Cloudflare service token and
the API bearer without scraping an external website.

For data safety, also create an independently verified SQLite backup
using [ARM64-BACKUP.md](ARM64-BACKUP.md) and test a restore into a
different, disposable volume. Never overwrite the only live database.

## Offline CI testing

```bash
node --test scripts/pi-preflight.test.mjs
```

CI uses synthetic Docker/Compose inspection fixtures to test unsafe
public port bindings, broken worker isolation, non-ARM64 images, absent
SQLite volumes, weakened container constraints, unhealthy services
and missing bearer authentication. These tests run on GitHub Actions
and **do not mean the Pi host itself has passed**.
