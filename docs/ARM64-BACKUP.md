# ARM64 and SQLite recovery validation — Issue #45

This phase adds automated checks for the actual ARM64 container images
and a **non-destructive SQLite online backup plus isolated restore drill**.
It does not deploy to, connect to, or modify your Raspberry Pi.

## Emulated ARM64 CI

The `Docker Compose deployment` workflow builds actual `linux/arm64`
API and worker images using Docker Buildx and QEMU on an AMD64 runner.
It executes:

- An ARM64 Node.js process with a real `node:sqlite` write/read test
- The API as a non-root ARM64 container with no external network, a
  read-only root filesystem and temporary writable filesystems
- The maintenance worker as an ARM64 container, also without a network
  interface, and verifies its heartbeat

A successful QEMU test proves ARM64 image startup, but **does not**
measure real Pi CPU performance, SSD durability, memory pressure, or
Cloudflare Tunnel connectivity. Test those separately on the Pi.

The regular Docker Compose CI also confirms the private API/worker
startup, bearer and host restrictions, and persistent SQLite state.

## SQLite online backup (no service shutdown)

Node.js 24 includes the `node:sqlite` `backup()` API, which makes a
transactionally consistent database snapshot even when SQLite uses
WAL journaling. Unlike copying only `dox.sqlite` while the server
is active, the backup captures committed rows stored in its WAL.

The repository provides `scripts/sqlite-backup.mjs`:

- Opens the source database read-only (never modifies the source)
- Backs up to a unique temporary file in the backup destination folder
- Runs `PRAGMA integrity_check` and `PRAGMA foreign_key_check`
- Requires the expected Dox database tables and a schema version
- Copies the snapshot to a **different temporary restore file**, opens
  that file independently and verifies its integrity and SHA-256
- Atomically publishes the backup using an exclusive hard link
- **Refuses to overwrite any existing destination**; permissions 0600
- Cleans up temporary copies on failure; no network calls or credentials

It requires sufficient free storage for the backup and its
temporary restore copy. During execution, the backup destination
needs approximately **2–3 times** the SQLite database size in
available free space. Put backups on an external SSD; transfer
encrypted backups to another device after verification.

### Create a backup from the running Pi Docker stack

Run in the repository root on the Pi:

```bash
mkdir -p backups
# If your host username has UID 1000, no ownership change is needed.
# The worker process runs with UID 1000 and must be able to write here.
docker compose run --rm --no-deps -T \
  --volume "$PWD/backups:/backups:rw" \
  --entrypoint node worker \
  /app/scripts/sqlite-backup.mjs \
  --source /data/dox.sqlite \
  --destination /backups/dox-$(date -u +%Y%m%dT%H%M%SZ).sqlite
```

This creates a **new backup file on the host** under `backups/`.
The Compose maintenance worker's network remains disabled. The
`api` container can continue running. Do not use a destination
inside the live SQLite volume, and do not reuse the same timestamp
after a failed or successful attempt.

If Docker reports `EACCES`, check filesystem ownership and
permissions. Never use `chmod 777` to bypass a backup write error;
create a dedicated writable backup directory owned by the
appropriate non-root UID instead.

### Safe restore drill

The backup command **already performs a dry-run restore** into
an isolated temporary SQLite file, checks database integrity and
then removes the temporary file. It never replaces
`/data/dox.sqlite` or modifies the live volume.

For a full deployment restore rehearsal, create a **separate**
Docker volume, stop test containers, copy a verified backup into
that volume and start an isolated test instance against it.
Never run restore commands into the production `dox_data`
volume while the API is active. Only restore a trusted, verified
backup. A full Pi volume-level restore rehearsal is still a
manual release gate.

### Tests

```bash
node --test scripts/sqlite-backup.test.mjs
bash scripts/verify-docker-base.sh
```

The backup unit tests create disposable WAL databases with synthetic
Dox schema/content, verify that committed rows survive online backup,
confirm destination non-overwrite behavior, and check failure cleanup.
Docker CI also runs the backup utility **inside the offline worker**
against its throwaway SQLite test volume. Nothing touches the
user's live data.

## Remaining real Pi deployment gates

- Confirm 64-bit Pi OS with `uname -m` (`aarch64`)
- Native `docker compose up --build -d` and health checks
- Observe CPU, RAM, SSD temperatures, and restart behavior under load
- Make a backup to off-device media and perform a full restore
  rehearsal in a different volume
- Configure your existing Cloudflare Tunnel + Access and run
  `node --env-file=.env scripts/verify-tunnel.mjs`
- Confirm only permitted sites are accessed and robots.txt is
  honored before enabling private crawl jobs

See [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md),
[DEPLOY-PI.md](DEPLOY-PI.md) and [CLOUDFLARE.md](CLOUDFLARE.md).

## Disposable-volume rollback rehearsal

In addition to a temporary-file restore, the Docker workflow now
verifies a pre-change SQLite backup by restoring into an **entirely
new disposable Docker named volume**, booting the API with that
copy, and proving that the original CI volume retains a simulated
post-change value. No live deployment or user's database is changed.

See [ROLLBACK-DRILL.md](ROLLBACK-DRILL.md) for the exact isolation
model, trusted checksum requirement and operator safeguards.
