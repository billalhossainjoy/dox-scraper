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

## Complete sanitized CI inventory — 2026-11-19 UTC

The follow-up [Docker run 44428952236](https://github.com/billalhossainjoy/dox-scraper/actions/runs/44428952236)
reported **46 HIGH advisory/package combinations** per image (0 CRITICAL,
0 fixable HIGH). They belong to **11 CVE IDs across six Debian source-package
families**, not 46 separate exploits. The API and worker findings overlap.

| Source family | CVE IDs observed | Installed binary packages flagged | Exposure assessment |
| --- | --- | --- | --- |
| util-linux | CVE-2026-76642; CVE-2026-78408; CVE-2026-78409; CVE-2026-78410 | bsdutils, libblkid1, liblastlog2-2, libmount1, libsmartcols1, libuuid1, login, mount, util-linux | Need to determine whether mount helpers or libraries receive attacker-controlled inputs; container drops capabilities and runs non-root |
| acl | CVE-2026-54369 | libacl1 | Symlink/ACL manipulation conditions require inspection of privileged callers; container is non-root |
| sqlite3 | CVE-2026-119373; CVE-2026-119374; CVE-2026-119379 | libsqlite3-0 | Debian shared library is installed, but in CI the Node process reports SQLite 3.54.1, FTS5 and SESSION enabled, and no dynamically loaded libsqlite3 shared object; other processes and SQL features still require review |
| systemd | CVE-2026-16742 | libsystemd0, libudev1 | Confirm whether affected systemd-homed service/code is present or callable inside the container |
| ncurses | CVE-2025-69720 | libtinfo6, ncurses-base, ncurses-bin | Reported issue concerns infocmp; check whether it is invoked on untrusted terminfo |
| perl | CVE-2026-9538 | perl-base | Reported issue relates to Archive::Tar; check whether Perl and Archive::Tar parse untrusted archives at runtime |

This table combines complete sanitized Trivy log evidence with preliminary
source-level applicability questions. It is not a validated exploitability
classification. The full *raw* scan report must remain on a trusted runner;
avoid publishing private registry metadata or environment variables.

Official Debian sources (recheck status on the day of release):
- https://security-tracker.debian.org/tracker/source-package/util-linux
- https://security-tracker.debian.org/tracker/source-package/acl
- https://security-tracker.debian.org/tracker/source-package/sqlite3
- https://security-tracker.debian.org/tracker/source-package/systemd
- https://security-tracker.debian.org/tracker/source-package/ncurses
- https://security-tracker.debian.org/tracker/source-package/perl

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

- [x] Collect and group all 46 reported unfixed HIGH advisory/package entries.
- [ ] Verify exploit conditions and exposure for each of the six source groups.
- [ ] Confirm Debian and upstream patch status; update targeted versions
      only when reviewed fixes exist.
- [ ] Review package usage and actual reachability, especially SQLite.
- [ ] Record owner approval or rejection of each residual risk.
- [ ] Pass frozen pnpm audits, Docker Trivy, AMD64 Compose, SQLite
      backup/restore and ARM64 checks on the release candidate.
- [ ] Complete physical Raspberry Pi preflight and isolated backup drill.
- [ ] Verify Cloudflare Tunnel plus Access dual authentication independently.

No real Pi, database, DNS, or Cloudflare settings are modified by this review.

## Recurring review and release policy

A scheduled Monday 03:17 UTC Docker/Compose scan detects newly published
findings in the same pinned images. A CRITICAL advisory now fails CI even if
Trivy lists no fixed version; a HIGH advisory with a fixed version also fails.
Unfixed HIGH findings remain visible but are not waived. The scheduled scan
skips emulated ARM64 for cost reasons; ARM64 must pass on any actual image
change or release PR. The owner must still explicitly decide on residual
risk after verifying the host and Cloudflare Access configuration.
