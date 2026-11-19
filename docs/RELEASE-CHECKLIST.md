# Private Raspberry Pi release readiness checklist

This checklist is for a **single-operator private deployment**, not an
unrestricted public scraping SaaS. It separates checks performed by
GitHub Actions from checks that require access to the real Raspberry
Pi, Cloudflare account and the websites being crawled.

## 1. Repository quality gates — checked in CI

- [x] Build all workspace packages on Node.js 24
- [x] Run TypeScript, ESLint and offline unit/integration tests
- [x] Check secure Docker Compose configuration
- [x] Build and start API and network-free maintenance worker
- [x] Assert Docker health checks and SQLite survival after recreation
- [x] Verify API bearer is independent of Cloudflare Access
- [x] Verify a demo/placeholder, short or repeated bearer key **cannot**
      start the production server
- [x] Verify redacted logs never include query strings or secret headers
- [x] Keep optional Chromium rendering disabled by default

An emulated ARM64 container smoke test also verifies that both images
start and run Node.js/SQLite under QEMU. Physical Pi hardware remains
unverified. A green CI run confirms these synthetic and container-level checks
but **does not** mean Cloudflare, the Raspberry Pi or a real website
has been tested.

## 2. Reproducible dependencies — locked, with further release checks

- [x] Commit a genuine pnpm 12.18.0-generated `pnpm-lock.yaml`
      covering all workspace importers
- [x] Enforce `pnpm install --frozen-lockfile` in CI and Docker builds
      and fail on manifest/lockfile drift
- [x] Add recurring pnpm dependency audits (production HIGH/CRITICAL
      and all-dependency CRITICAL), Dependabot update PRs and a
      container HIGH/CRITICAL-with-fix release gate
- [x] Update the runtime Node 24 Debian 13 Trixie image, remove unused
      global npm and pin the available `zlib1g` security fix
- [ ] Review outstanding HIGH/unfixed advisories and package licenses
      manually before public deployment
- [x] Pin an official Node 24 **multi-architecture OCI index digest**
      in both Docker stages, and verify AMD64 plus ARM64 in Docker CI
- [ ] Record a signed/verified release commit or tag for rollback

The committed lockfile pins npm dependencies, and the Dockerfile now
pins the multi-platform official Node base image by an immutable index
digest. Update this digest explicitly when Node or Debian patches are
released; keeping a digest fixed also keeps older vulnerabilities
until the pin is refreshed. Never fabricate a lockfile or digest.

## 3. Real Raspberry Pi validation — operator must perform

- [ ] Confirm the Pi OS is 64-bit with `uname -m` showing `aarch64`
- [ ] Confirm Docker and Docker Compose Plugin versions
- [ ] Store the Docker volume on a writable SSD and verify UID 1000
      can write `/data/dox.sqlite`
- [ ] Generate an independent 32-byte API bearer token:
      `openssl rand -hex 32`
- [ ] Place it only in the untracked local `.env` (permissions `0600`)
- [ ] Set `NODE_ENV=production` (already configured in Compose)
- [ ] Run `docker compose config --quiet`
- [ ] Run `node scripts/pi-preflight.mjs` on the actual Pi and resolve
      every FAIL before enabling the external hostname
- [ ] Run `docker compose up --build -d` and `docker compose ps`
- [ ] Verify `curl --fail http://127.0.0.1:3000/health`
- [ ] Verify no Raspberry Pi LAN/public interface is listening on
      port 3000 (the Compose binding is `127.0.0.1` only)
- [ ] Check API/worker memory, CPU, logs and health for sustained use
      (preflight checks configured caps and current health, not load performance)
- [ ] Run allowed, low-volume test scrapes against a site you
      control, not arbitrary third parties

## 4. Cloudflare Tunnel and Access — operator must perform

- [ ] Verify the existing tunnel connector runs **on the Pi host**,
      or explicitly design private routing if it runs elsewhere
- [ ] Route a dedicated scraper subdomain to
      `http://127.0.0.1:3000` on that connector's host
- [ ] Create the matching Access application covering all paths,
      with a narrow **Service Auth** policy and no bypass rules
- [ ] Enable **Protect with Access** for the published tunnel hostname
- [ ] Set `DOX_PUBLIC_HOSTNAME` to the exact lowercase DNS hostname
- [ ] Generate and store Cloudflare service-token credentials separately
      from the Dox Scraper API bearer key
- [ ] Run `node --env-file=.env scripts/verify-tunnel.mjs`
- [ ] Confirm unauthenticated requests are denied, Access-only
      requests still need the API bearer, and valid dual-auth
      requests reach the API
- [ ] Confirm the Docker worker and SQLite database have **no**
      publicly exposed ports

## 5. Data safety, failure recovery and maintenance

- [ ] Make a cold backup of the SQLite named volume, including
      WAL/SHM sidecars where present
- [ ] Verify a **real Pi backup** can restore into a separate test
      volume without overwriting the only live copy
- [x] Exercise WAL-consistent backup and independent restore on
      disposable SQLite databases in CI
- [x] Rehearse a simulated rollback into a separate disposable Docker
      volume, boot the restored API and verify the original CI volume
      retains its post-change data
- [ ] Test a restart with an incomplete job and inspect
      `PROCESS_RESTARTED` handling
- [ ] Confirm a restricted `robots.txt` path is never fetched,
      using a test website you own
- [ ] Check error responses do not reveal secrets and log rotation
      prevents disk exhaustion
- [ ] Document who may access Docker daemon and tunnel credentials
- [ ] Plan secret rotation and retention/cleanup of old crawl results
- [ ] Confirm you can roll back containers on the **real Pi** without
      deleting SQLite data; do not run `docker compose down --volumes`
- [ ] Verify application image and database schema compatibility before
      attempting a real release downgrade

## 6. Public availability gate

**Do not advertise an unrestricted production scraping endpoint.**
The deployment is intended for one authenticated operator, with
explicit origin allowlists for crawl jobs, robots.txt checks, SSRF
protection, bounded requests and per-host throttling. The
single-page `/v1/scrape` route is a bounded HTTP scraper but does
not implement the crawl manager's complete robots.txt checks;
use only targets where you have permission.

Before scaling or opening to additional tenants, add durable job
leases, global rate coordination, separate tenant keys and isolation,
storage quotas, broader operational monitoring and external
script handling via an isolated browser architecture.

## Useful documentation

- [Raspberry Pi setup](DEPLOY-PI.md)
- [Cloudflare Tunnel and Access setup](CLOUDFLARE.md)
- [Crawl API and site-policy safeguards](CRAWL_API.md)
- [SQLite backups and restart handling](STORAGE.md)

GitHub Actions now performs a weekly dependency advisory check and
scans built API/worker Docker images for fixable HIGH/CRITICAL findings.
The latest scan still found **46 HIGH OS advisories per image without
reported fixes**. Review them before deployment; these jobs do
**not** guarantee the absence of vulnerabilities. See
[SECURITY-SCANNING.md](SECURITY-SCANNING.md).

For the exact per-image findings, mitigation history and Debian apt
pin caveat, see [VULNERABILITY-REMEDIATION.md](VULNERABILITY-REMEDIATION.md).
