# 15 — P1 Remediation Status (R-05 … R-08)

Follow-up to `14-p0-remediation-status.md`. Branch `claude/busy-pascal-h6hvhh`, code commit `67a4783` (CI run #1 green), 2026-10-03.

Evidence:
- **Regression tests:**
  - `tests/integration/resource-limits.test.ts` (R-05, 9 tests)
  - `tests/unit/context-selection.test.ts` (R-06, 3 tests)
  - `tests/integration/audit-integrity.test.ts` (R-08, 8 tests)
- **Red-team re-run:** `docs/audit/poc/redteam-results-after-p1.json`. Earlier runs are kept in `redteam-results.json` (audit) and `redteam-results-after-p0.json`.
- **Full suite:** 273 passed, 9 skipped. The 9 skipped tests are real-provider tests that need LM Studio, ComfyUI, macOS or ElevenLabs.

## What changed

### R-05: resource exhaustion (F-05)

| Control | Implementation | Default |
|---|---|---|
| Async requests cannot bypass the concurrency cap | `jobs.reserved` distinguishes synchronous jobs (held by the caller) from async jobs. Unfinished async jobs count against `JOVI_MAX_CONCURRENT_GOALS` in SQLite, so the count holds across the API and worker processes | 2 |
| Queue cap | `JobQueue.assertCapacity()` runs at every entry point before a task is created (no orphan tasks), and again in `enqueue` as a backstop. Refusal → 429 | `JOVI_MAX_QUEUED_JOBS=20` |
| Write rate limits | `memory`, `decision` and `visual-identity` writes, per principal → 429 with `Retry-After` | `JOVI_WRITE_RATE_LIMIT_PER_MINUTE=30` |
| External memory cap | Total API-written memory items → 429 beyond the cap; updates to existing keys are still allowed | `JOVI_MAX_EXTERNAL_MEMORY_ITEMS=500` |
| Slow clients | Fastify `requestTimeout`: time to receive the whole request. Long handlers are not cut off | `JOVI_REQUEST_TIMEOUT_MS=30000` |
| Regeneration cap | Per production, counted from `MEDIA_REGENERATION_REQUESTED` events → 409 | `JOVI_MAX_MEDIA_REGENERATIONS=5` |
| Media disk quota | `MediaService` refuses generation (`MEDIA_QUOTA_EXCEEDED`, asset `BLOCKED`, no provider call) once the media directory reaches the quota. Symlinks are not followed when measuring | `JOVI_MEDIA_QUOTA_MB=20480` |
| Superseded-media GC | The worker deletes the files of `SUPERSEDED` assets once a day. Records stay, marked `purgedAt` / `purgedBytes`. Only regular files inside the media root are removed (no symlinks). `MEDIA_GC_COMPLETED` is emitted when something was deleted. CLI: `--media-gc [--dry-run] [--older-than-days N]` | `JOVI_SUPERSEDED_RETENTION_DAYS=7` |
| Daily cloud budget | `CloudBudget` sums today's (UTC) estimated cloud cost: `model_runs` with `execution_cost_type='API'`, plus `media_assets` from CLOUD providers. When the budget is reached, the router drops cloud models (local ones still run) and media requirements exclude cloud providers. `0` disables cloud. Unknown estimates count as 0: this is a guard rail, not an invoice | `JOVI_DAILY_CLOUD_BUDGET_USD=10` |

`/api/status` now reports the budget (limit, spend today, exhausted reason) and job counts.

### R-06: context flooding (F-06)

`selectContextMemory` builds the memory slice for a context. It:
- drops items below a relevance floor (`minMemoryRelevance` 0.08, the share of goal terms matched);
- reserves up to 6 of the 10 slots for trusted (seed) memory;
- allows at most 2 untrusted (API) items;
- fills the remaining slots by score.

Candidates come from two separate pools, internal (seed/agent) and external (API). That means a flood of high-importance external items cannot push curated memory out before scoring.

### R-07: SDLC / supply chain (F-07)

**Committed:**
- **`.github/workflows/ci.yml`** has three jobs:
  - `Typecheck, test, build`
  - `Dependency audit + SBOM`:
    - `npm audit --omit=dev` fails on any runtime advisory; the full tree fails on high or critical;
    - osv-scanner runs on the lockfile;
    - a CycloneDX runtime SBOM is uploaded as an artifact.
  - `Secret scan (gitleaks, full history)`
- **Pinning:**
  - `permissions: contents: read`, and `persist-credentials: false` on checkout.
  - Every action is pinned to a full commit SHA. The SHAs were resolved with `git ls-remote` against the upstream repositories:
    - checkout v7.0.1 `3d3c42e5…`
    - setup-node v7.0.0 `82076278…`
    - upload-artifact v7.0.1 `043fb46d…`
  - gitleaks 8.30.1 and osv-scanner 2.6.0 are downloaded as release binaries and checked against SHA-256 values from the official checksum files. I verified both checksums when downloading them here.
- **`.github/dependabot.yml`:** npm, github-actions and docker, weekly.
- **`docker/Dockerfile`:** both stages are pinned to `node:22-bookworm-slim@sha256:43ac6c60…772c` (Node 22.23.3), resolved from Docker Hub on 2026-10-03.
- **`.gitleaks.toml`:** the default rules plus exact-value allow-list entries for the red-team canaries and decision-memory ids. Run locally with the CI configuration, gitleaks scanned the full history and the working tree and found no leaks.
- **`osv-scanner.toml`:** ignores GHSA-67mh-4wv8-2f99 (an esbuild dev-server issue reached only through drizzle-kit, a devDependency), with a reason and an expiry of 2027-01-31. The latest stable drizzle-kit (0.31.11) is still affected, and npm's only fix is a breaking downgrade, so no non-breaking path exists yet.
- **`docs/security/sdlc-runbook.md`:** the owner-only steps.

**Owner-only, not done:**
- The repository still has a single branch, `claude/busy-pascal-h6hvhh`. It is unprotected and there is no `main`. This session may push only to its working branch, so creating `main`, branch protection or rulesets, required checks and phase tags are left to the owner. The runbook gives the exact steps.
- Dependabot acts on the default branch, which today is `claude/busy-pascal-h6hvhh`.

osv-scanner could not query `api.osv.dev` from this sandbox (403 from the proxy), so it was first exercised for real in the GitHub CI run. See *CI status* below.

### R-08: audit integrity and coverage (F-09, F-17)

- **Hash chain:** every event stores `prev_hash` and `hash = sha256(prev_hash ‖ canonical row)`. The sequence number and the link are computed inside one `BEGIN IMMEDIATE` transaction, so concurrent writers (API + worker) cannot fork the chain.
  - `verifyChain()` reports the first break: an edited row, a deleted row (sequence gap), a removed hash or a broken link.
  - `verifyEvent()` checks a single event and its link.
  - Upgraded databases keep their pre-chain events as a reported `legacyUnchained` prefix. I checked this against the P0 smoke-test database.
- **Protected event types:** `PRODUCTION_APPROVED`, `PRODUCTION_REJECTED`, `VISUAL_IDENTITY_VERSION_CREATED`, `API_CREDENTIAL_CREATED` and `API_CREDENTIAL_REVOKED`.
  - They are refused on the generic emit path. Only the services holding the attestation capability can emit them; the bus issues it once at bootstrap, and a second request is refused.
  - The visual-identity event moved from the API and CLI handlers into `VisualIdentityService`.
- **Approval reconciliation:** `publishingGate` adds an "approval not attested" blocker unless an `APPROVED` status has a `PRODUCTION_APPROVED` event that:
  - was emitted by the production service;
  - names the same reviewer;
  - passes the hash-chain check.
- **Audit coverage:**
  - 401 and 403 refusals (Host/Origin, missing or invalid credential, missing scope) are stored as `API_AUTH_FAILED` events. They are throttled at 20 per client per minute, and the number suppressed is reported on the next event.
  - Every external process execution (ffmpeg, ffprobe, say) is logged with the binary name, arguments (paths reduced to `<path>/basename`), duration, exit code and outcome.
- **Verification:** `GET /api/audit/verify` (`approve` scope) and `npm run jovi -- --audit-verify` return the chain head, so it can be recorded outside the machine.

## Red team: after P0 → after P1

| Check | After P0 | After P1 | Note |
|---|---|---|---|
| RT-02b untrusted memory flooding | VULNERABLE | **HELD** | 12 stuffed items → 2 untrusted and 7 trusted in context |
| RT-05c SQL-forged approval | VULNERABLE | **HELD** | Gate blocker: "approval not attested: no PRODUCTION_APPROVED event exists" |
| RT-14 async queue / memory-write exhaustion | VULNERABLE | **HELD** | Async: `[202, 202, 429 ×6]`; memory writes: 30 accepted, 270 got 429 |
| RT-17a in-process event forgery / tamper evidence | VULNERABLE | **HELD** | Forgery → `PermissionDeniedError`; a 1-row edit is detected at its sequence |
| RT-04b `production.write` not scoped by kind | VULNERABLE | VULNERABLE | P2 R-10 |
| RT-09 symlink escape | VULNERABLE | VULNERABLE | P2 R-09 (the new GC and quota code do not follow symlinks; the confinement checks are unchanged) |
| RT-19 likeness text in visual identity | PARTIAL | PARTIAL | P2 R-11 |

Totals: after P0, 20 HELD / 6 VULNERABLE / 1 PARTIAL. **After P1: 24 HELD / 2 VULNERABLE / 1 PARTIAL** (27 checks).

## Security gate: after P0 → after P1

| Gate | After P0 | After P1 | Basis |
|---|---|---|---|
| A | PASS | PASS | No Critical findings |
| B | PASS | PASS | Unchanged |
| C | CONDITIONAL PASS | CONDITIONAL PASS | Approval forgery by editing the database is now refused (RT-05c). *Narrowed condition:* a local attacker with database write access can still append a correctly re-hashed approval event at the end of the chain. Recording the head outside the machine (runbook §6) detects this; a keyed or anchored log is recommended before Phase 10 |
| D | CONDITIONAL PASS | CONDITIONAL PASS | Unchanged (F-10 → R-10, F-19) |
| E | PASS | PASS | Process executions are now also logged |
| F | CONDITIONAL PASS | CONDITIONAL PASS | Unchanged (symlinks, R-09) |
| G | PASS | PASS | gitleaks (8.30.1) found no leaks in the history or working tree |
| H | PASS | PASS | 0 runtime advisories; 4 moderate dev advisories (drizzle-kit → esbuild), now documented with an expiry |
| **I** | CONDITIONAL PASS | **PASS** | Laundering into trusted memory (RT-01) and context flooding (RT-02b) are closed |
| J | CONDITIONAL PASS | CONDITIONAL PASS | Unchanged. The safety review has still not been run against a real local model |
| **K** | CONDITIONAL PASS | **PASS** | Authenticated actors; tamper-evident chain; protected event types; auth-failure events; process-execution records (RT-17a). The residual tail-append risk is covered under C |
| **L** | FAIL | **CONDITIONAL PASS** | CI, SHA-pinned actions, checksum-verified scanners, secret scanning, SBOM, Dependabot and digest-pinned images are all committed. *Condition:* the owner must create and protect `main` with the required checks (runbook). Until then, nothing stops an unreviewed push |

**Overall gate verdict: CONDITIONAL PASS.** No gate fails. The remaining conditions are:
1. The owner creates and protects `main` (L).
2. The safety review gets a real-model validation (J).
3. The chain head is anchored externally, or the log is keyed, before publishing (C).
4. The P2 items for D and F.

**CSO answer:** **yes, conditionally, for attended, human-approved local production** once conditions 1 and 2 are met. Still **no** for unattended (autonomous) production and for Phase 10 publishing. Publishing additionally needs condition 3, an independent human security review, and a fresh audit of the publishing design.

## CI status (first real run)

The push of `67a4783` triggered CI run #1 ([run 37106188056](https://github.com/Jatin18012000/Jovi-Ai-Influencer-model-/actions/runs/37106188056)): **success**, all three jobs green.

| Job | Result | Notes |
|---|---|---|
| Typecheck, test, build | success | Same suite as local: 273 passed, 9 skipped |
| Dependency audit + SBOM | success | Runtime `npm audit` 0 advisories; full tree has no high/critical. osv-scanner binary checksum OK. Scanned 247 packages; GHSA-67mh-4wv8-2f99 filtered with its documented reason; "No issues found". CycloneDX SBOM uploaded as artifact `sbom-runtime-cdx` |
| Secret scan (gitleaks, full history) | success | gitleaks binary checksum OK; no leaks |

Dependabot is already active: `claude/busy-pascal-h6hvhh` is currently the default branch. Its first npm, github-actions and docker update runs started on this push. Any update pull requests it opens target this branch until `main` exists.

## Remaining

- **P2:**
  - R-09: symlink confinement.
  - R-10: `production.write` scoped by artifact kind.
  - R-11: likeness and minor checks on human-entered visual identity.
  - R-12: generic 5xx bodies.
  - R-14: container hardening (`read_only`, `cap_drop`, limits).
  - R-15: streamed download byte caps.
  - R-16: classifier verbs.
  - R-17: trust-model documentation and hash-pinning of configured binaries.
  - R-18: retention, backups and permissions on `data/`.
  - R-19: documentation drift.
- **Owner steps:** `main`, branch protection, repository security settings and phase tags.
- **Real-model validation** of the pre-generation safety review against LM Studio.
