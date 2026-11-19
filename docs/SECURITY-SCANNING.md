# Dependency and container security checks — Issue #54

Dox Scraper includes two complementary security checks: a recurring
pnpm dependency advisory audit and Docker image vulnerability scanning.
They are release controls for a **private Raspberry Pi deployment**,
not evidence that an arbitrary live website or production host is secure.

## 1. Locked Node.js dependency audit

`.github/workflows/security.yml` runs when dependency manifests or
the pnpm lockfile change, on pushes to `main`, on a Monday schedule,
or when manually dispatched from GitHub Actions.

The job uses the repository's pinned pnpm **12.18.0**, Node.js 24
and `pnpm install --frozen-lockfile --ignore-scripts`.

Two audits run separately:

- `pnpm audit --prod --audit-level high` — blocks known HIGH or
  CRITICAL production dependency advisories.
- `pnpm audit --audit-level critical` — blocks CRITICAL advisories
  anywhere in the dependency graph, including development tools.

A registry outage or failed audit is **not** treated as passing;
review both audit steps if the security job fails. Audit results
can change after a merge because new advisories may be published,
even though the lockfile remains unchanged.

GitHub Dependabot is configured to propose (not auto-merge) weekly
updates to the pnpm workspace and GitHub Actions references. Review
package manifest and lockfile changes, then wait for CI. The
Dependabot config does not imply automatic patch deployment to your Pi.

## 2. Docker image vulnerability scans

The `.github/workflows/docker.yml` deployment job builds the actual
API and worker images, then uses **Aqua Trivy v0.76.1** to inspect
both images' installed OS and library packages.

The scanner GitHub Action is pinned to the verified upstream
`v0.36.0` source commit
`ed142fd0673e97e23eac54620cfb913e5ce36c25`.
Use immutable action commits, **not floating tags**, especially
because a prior Trivy supply-chain compromise affected historical
action tags and a released binary. The scanner binary is also fixed
to a specific version; audit updates before changing either pin.

Each image scan emits a JSON report for the job's local CI workspace.
`scripts/check-container-vulnerabilities.mjs` reads both reports,
validates their structure and prints only summarized advisory counts
plus bounded, validated CVE/GHSA identifiers. The additional
`scripts/triage-image-vulnerabilities.mjs` gives a sanitized,
24-entry-per-image list of CRITICAL/fixable HIGH affected packages and reported fixed versions, plus a separately bounded inventory of up to 64 unfixed HIGH advisory/package entries (including the total distinct count).

**Policy:**

- Any **HIGH or CRITICAL** finding for which Trivy identifies a
  fixed package version blocks the Docker release CI job.
- CRITICAL and HIGH findings **without** reported fixes remain visible
  for human review. A missing fix does **not** imply the issue is harmless.
- Invalid or missing vulnerability scan output fails the job.
- The scanner does not receive the private API bearer, live SQLite
  data or your Cloudflare credentials. No Compose environment
  dump is uploaded to artifacts.

This deliberately distinguishes "known fix available" from
"not yet fixed." It does **not** claim zero HIGH vulnerabilities,
zero CRITICAL vulnerabilities, or comprehensive zero-day protection.

## 3. Responding to audit failures

1. Open the failed GitHub Actions audit or Docker scanning step.
2. Determine whether each issue affects the **runtime**,
   development dependencies, the Node.js base image, or a
   transitive package.
3. For pnpm findings, update the relevant direct dependency or
   parent package deliberately. Regenerate and review
   `pnpm-lock.yaml`; never manually forge integrity hashes.
4. For base-image findings, identify and verify a patched official
   Node multi-platform index digest, update `docker/Dockerfile`,
   and rerun `bash scripts/verify-docker-base.sh`.
5. Re-run both application and Docker CI, including ARM64 emulation
   and SQLite persistence/rollback tests, before merging.
6. If no fix exists, document the advisory, actual exposure,
   available mitigation and an explicit decision. Do **not**
   silently suppress vulnerabilities or assume "unfixed" is safe.

## 4. Manual commands

From the repository root:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm audit --prod --audit-level high
pnpm audit --audit-level critical

node --test scripts/check-container-vulnerabilities.test.mjs
node --test scripts/triage-image-vulnerabilities.test.mjs
```

Use GitHub Actions for actual container image scanning, because the
Docker job builds the correct pinned release images and invokes the
pinned scanner on each image. Do not paste real API keys into scanner
configuration or commit live `.env` files.

## 5. Remaining release gates

This change does not prove the Raspberry Pi is configured safely.
You still need a successful `node scripts/pi-preflight.mjs` run
**on the physical Pi**, a separate real SQLite backup/restore
drill, and `node --env-file=.env scripts/verify-tunnel.mjs`
against the correct Access-protected Cloudflare hostname.

See [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md),
[PI-PREFLIGHT.md](PI-PREFLIGHT.md) and
[CLOUDFLARE.md](CLOUDFLARE.md).

## 6. Runtime image remediation evidence

Issue #56 replaced the original Node.js 24 Debian Bookworm base with
a verified, immutable **Debian 13 Trixie** multiarchitecture index.
The runtime images no longer contain globally bundled npm; the
specific Debian `zlib1g` security fix is version-pinned.

The observed scanner counts changed from **1 CRITICAL and 43 HIGH**
per image on Bookworm, to **0 CRITICAL and 46 HIGH** per image with
**no HIGH/CRITICAL fixes remaining reported** after remediation.
The 46 HIGH OS advisories without reported fixes remain a release
risk to assess, not evidence of zero vulnerability.

See [VULNERABILITY-REMEDIATION.md](VULNERABILITY-REMEDIATION.md)
for exact CVEs, the target image digest, the targeted patch and
reproducibility limitations.

## 7. Issue #65 — review of unfixed HIGH advisories

Docker CI now prints a **separate, sorted, sanitized and capped** listing of
unfixed HIGH advisory/package combinations for both images. It reports the
full distinct-item count even when the output is capped at 24 entries per
image. This is for human review, **not** an automatic waiver or finding that
these vulnerabilities are unreachable. API and worker results overlap.

Use the latest successful Docker Compose deployment run's
"Report categorized CRITICAL and fixable HIGH advisory details" step to
collect the public CVE IDs, packages and installed versions. For every
finding, inspect the current Debian advisory and upstream patch status,
classify runtime exposure (including whether the vulnerable feature is
reachable), record compensating controls, and obtain an explicit risk decision.
The scanner's empty FixedVersion is not proof that no patch exists.

If the complete list has more than 24 entries, perform an authorized,
local review of the full Trivy JSON reports from a trusted runner or
workstation. Do not upload raw reports with private image metadata to
public workflow artifacts. Any new patched base/package must pass the
existing quality, Docker, SQLite and ARM64 checks before release.
**The Issue #65 release gate remains open** until that review and the
physical Pi/Cloudflare preflight have actually been completed.

For Issue #65, the unfixed HIGH entry limit was raised from 24 to 64 so the
latest observed 46 advisory/package combinations per image can be reviewed
from sanitized CI logs without publishing the complete Trivy JSON. If the
count exceeds 64, CI explicitly states that entries were omitted and the
full local report must be reviewed securely before launch.

Node's built-in `node:sqlite` may use a different SQLite library/version
than Debian's installed `libsqlite3-0` package. The Docker workflow logs
sanitized runtime SQLite version, build feature flags relevant to the
published CVEs, and presence of a loaded libsqlite3 shared object. This
provides evidence for assessment but does **not** prove a finding harmless
or remove the requirement to review OS and bundled dependencies.
