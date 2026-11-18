# Disposable SQLite rollback rehearsal — Issue #49

This release check demonstrates that a backup made **before** a simulated
change can be restored and booted in an **independent Docker volume**.
It is a rehearsal, not a command that restores the production database.

## Safety boundary

The tool `scripts/sqlite-restore-drill.mjs` is intentionally more
restricted than a general restore utility:

- It requires a backup file and a **trusted SHA-256** checksum.
- The target must be a real directory with exactly one file:
  `.dox-disposable-restore-volume` containing the expected sentinel.
- It refuses symlinked source files, symlinked targets, existing target
  database files, extra files, overlapping paths and invalid SQLite
  schemas.
- It checks `PRAGMA integrity_check`, `foreign_key_check` and the
  expected Dox table set on the disposable copy after checksum verification.
- It uses exclusive creation (`COPYFILE_EXCL`), so an existing file
  is never replaced, and removes its newly copied file on failure.
- The command-line entry point **only accepts** the target mount path
  `/restore-drill`; it explicitly refuses `/data`.
- It never executes SQL writes against the backup or the live database.

The **existing** `sqlite-backup.mjs` tool can create a consistent
online SQLite snapshot while the application is running, including
committed changes in WAL. The restore drill verifies the backup
independently and does not rely on copying a live database's main
file or ignoring WAL sidecars.

The checksum must be recorded by a trusted operator at backup
creation time. It verifies the bytes, **not** who supplied the
backup. Do not import untrusted third-party SQLite files.

## Automated CI rehearsal

The Docker Compose CI workflow uses its own temporary database
and performs the following:

1. Start the API and maintenance worker on the test runner.
2. Insert a synthetic `deployment_probe` value of `persisted`.
3. Take a verified SQLite backup using the networkless worker.
4. Change the original CI volume's probe to `after-upgrade`,
   simulating an unwanted release change.
5. Create an **entirely new named Docker volume** for the rollback.
6. Initialize only that new volume's directory permissions and
   its required disposable marker file.
7. Restore the backup into that volume using a **non-root,
   networkless container**, and verify its SHA-256 and SQLite
   consistency.
8. Assert that the new volume still contains `persisted`, boot
   the Hono API with the restored volume and no published ports,
   and confirm the API health endpoint.
9. Verify the original CI volume still contains
   `after-upgrade`; the restore operation did not modify it.
10. Remove the disposable rollback container and volume after
    the rehearsal.

The CI values are synthetic and the original volume is itself
an **ephemeral GitHub CI volume**. The test does **not** alter
any user's production SQLite database, Raspberry Pi, or
Cloudflare Tunnel.

## Running the offline tests

```bash
node --test scripts/sqlite-restore-drill.test.mjs
pnpm lint
pnpm test
```

The offline tests cover a WAL-backed pre-change snapshot, mismatch
with a trusted checksum, missing or forged marker, symlinked inputs,
existing destination, corrupt backup and path validation.

## Before a real deployment rollback

Never automatically overwrite `dox_data` as part of a release
pipeline. A real rollback requires an explicit, operator-approved
maintenance window, a prior backup and knowledge of migrations
made by the new version. In particular, **downgrading application
code does not downgrade SQLite schema**, and older releases can
refuse newer database versions.

For your Raspberry Pi:

- First run `node scripts/pi-preflight.mjs` on the Pi itself.
- Make an independent, checksum-verified backup to external SSD
  or another trusted medium.
- Rehearse the backup on a **new** disposable volume, not the
  existing production named volume.
- Test a known-good image against that separate restored volume.
- Verify your Cloudflare Access policy separately, with
  `node --env-file=.env scripts/verify-tunnel.mjs`.
- Plan any actual restore with a tested schema migration and
  a clear stop/backup/restore/restart procedure.

See [ARM64-BACKUP.md](ARM64-BACKUP.md),
[RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) and
[PI-PREFLIGHT.md](PI-PREFLIGHT.md).
