# Issue #65 — Debian HIGH advisory review (work in progress)

Evidence collected on 2026-11-19 UTC. **This is not release approval or risk acceptance.**

## Evidence and scope

- PR #66 Docker Compose scan on the pinned Node 24 / Debian 13 Trixie image
  found 0 CRITICAL and 46 HIGH OS advisory/package combinations per image,
  with 0 Trivy-reported fixable HIGH entries. API and worker share a runtime
  base and have overlapping findings. Evidence: GitHub Actions run 44428011175.
- The sanitized PR #66 report displayed 24 of 46 entries. The next scan's
  unfixed-HIGH cap is 64, still sanitized and bounded; it should expose all
  46 if the count remains below the cap. Raw Trivy JSON must stay local.
- Multiple binary packages can map to one source-package CVE, so advisory
  counts are not counts of independent exploits. No FixedVersion in a scanner
  report does not establish that no upstream patch exists.

## Confirmed groups from the first 24 entries

| Source area | CVEs observed in CI | Preliminary status |
| --- | --- | --- |
| util-linux: bsdutils, libblkid1, liblastlog2-2, libmount1, libsmartcols1 | CVE-2026-76642, CVE-2026-78408, CVE-2026-78409, CVE-2026-78410 | Needs exposure and Debian patch review; several packages share the same advisory |
| acl: libacl1 | CVE-2026-54369 | Debian Trixie marks vulnerable; upstream acl 2.4.0 fix exists; check privileged pathname operations |
| sqlite3: libsqlite3-0 | CVE-2026-119373, CVE-2026-119374, CVE-2026-119379 | Review installed Debian SQLite, Node built-in SQLite, FTS5/session features, and untrusted inputs |
| Other package/advisory combinations | 22 entries not included in previous 24-row output | Await full sanitized inventory; no risk decision possible yet |

Official references:
- https://security-tracker.debian.org/tracker/source-package/util-linux
- https://security-tracker.debian.org/tracker/CVE-2026-76642
- https://security-tracker.debian.org/tracker/CVE-2026-54369
- https://security-tracker.debian.org/tracker/source-package/sqlite3
- https://www.sqlite.org/cves.html

## Exposure questions — NOT an automatic waiver

The checked-in Compose configuration runs both services as non-root,
with read-only root filesystems, all Linux capabilities dropped,
no-new-privileges and resource limits. The worker has no network access.
The API is bound to host loopback and separately requires an API bearer.
These controls potentially limit some exploit paths; they do not establish
that vulnerable code cannot run.

1. util-linux: Determine whether either service invokes mount, umount,
   privileged fstab processing, or related helpers, including through
   dependencies. Verify the actual deployed capability restrictions.
2. libacl: Identify any privileged calls using attacker-controlled paths
   to acl_get_file, acl_set_file and related functions. The symlink issue
   requires specific caller behavior.
3. SQLite: Node's built-in node:sqlite can use a different SQLite engine
   from Debian's installed libsqlite3-0. Docker CI now records the runtime
   sqlite_version(), ENABLE_FTS5, ENABLE_SESSION and the presence of a
   loaded libsqlite3 shared object. Also inspect the application's SQL,
   schema, user-provided input flows and potential database-file inputs.
   Runtime version/feature checks alone are not proof of non-exploitability.
4. Other advisories: Once the full list is available, classify *every*
   finding by source package, Debian advisory status, actual exploit
   prerequisites, runtime exposure, and compensating controls. Record an
   explicit review decision for each root cause, not each duplicated binary.

Do not indiscriminately update or remove core OS libraries, switch libc
families or cross-grade Debian releases without compatibility and security
tests on both AMD64 and ARM64.

## Release gate — remains blocked

- [ ] Collect and classify all unfixed HIGH inventory entries.
- [ ] Confirm Debian and upstream patch status; update targeted versions
      only when reviewed fixes exist.
- [ ] Review package usage and actual reachability, especially SQLite.
- [ ] Record owner approval or rejection of each residual risk.
- [ ] Pass frozen pnpm audits, Docker Trivy, AMD64 Compose, SQLite
      backup/restore and ARM64 checks on the release candidate.
- [ ] Complete physical Raspberry Pi preflight and isolated backup drill.
- [ ] Verify Cloudflare Tunnel plus Access dual authentication independently.

No real Pi, database, DNS, or Cloudflare settings are modified by this review.
