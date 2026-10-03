# 12 — Security Remediation Roadmap

Ordered by risk reduction per unit of effort. **None of these fixes were applied during the audit.** Each item names the regression test it needs: convert the matching `docs/audit/poc/redteam.mts` check into a vitest test once fixed.

## P0 — before any further feature work (blocks Gates B, I, J)

| # | Finding | Remediation | Regression test |
|---|---|---|---|
| R-01 | F-01 unauthenticated default API / DNS rebinding | (1) Make `JOVI_API_TOKEN` **mandatory**: generate a random 256-bit token on first run, store it in `.env` or the OS keychain, and print it once. (2) Add a **Host allow-list** (`127.0.0.1`, `localhost`, configured hostnames) and reject other Host values with 421/403. (3) Reject requests whose `Origin` is present and not allow-listed. (4) Keep `/health` minimal (`status` only) when unauthenticated | RT-05b, RT-06: spoofed Host → 403; no token → 401 |
| R-02 | F-02 identity/safety guard bypass before generation | (1) Add a **pre-generation safety gate** in `MediaService`/media agents: no media request leaves Jovi unless a second, independent check passes. The check should be either a model-graded safety classifier with a fixed rubric (age ≥ 21 apparent, adult framing, AI transparency) or a curated allow-list approach. (2) Widen the deterministic patterns (number words, "year(s) old" without a subject, "school uniform", "girl" + age < 21, "human"/"person"/"not AI" paraphrases) and treat deterministic checks as *heuristic*: QA should report "no violation found by heuristic", not PASSED. (3) Optionally gate image generation behind a human "prompts approved" step for new productions | RT-12 corpus (expand to ≥ 50 adversarial phrasings); "minor descriptor in idea → no media request issued" |
| R-03 | F-03 injection laundered into trusted memory | (1) Record **provenance**: memory derived from user- or API-supplied text (objective, concept, hook) is `source=agent:executive`, `derivedFrom=untrusted`, and is rendered as untrusted. (2) Render "Recent decisions" and "Similar past concepts" inside `<memory_data>` with trust labels. (3) Do not store the raw objective; store a hash or a sanitized summary | RT-01: injected goal → never labelled trusted; recent-decision text inside data tags |
| R-04 | F-04 approval not bound to a human | (1) Separate scopes and tokens: `read`, `operate` (goals, productions), `approve`, `identity-admin`. (2) The approval and visual-identity endpoints require the `approve`/`identity-admin` scope, and the reviewer is **derived from the credential**, not the body. (3) Add a confirmation step for approvals (second factor or CLI re-prompt). (4) Must be complete **before Phase 10 publishing** | RT-05d: operate-token approve → 403; reviewer equals the token principal |

## P1 — next iteration (Gates K, L; Medium findings)

| # | Finding | Remediation | Regression test |
|---|---|---|---|
| R-05 | F-05 resource exhaustion | Hold the concurrency slot for async jobs (count QUEUED + RUNNING); cap the queue (e.g. 20); rate-limit `/api/memory`, `/decision` and `/visual-identity`; set Fastify `requestTimeout`; add a per-production regeneration cap; add a media disk quota and GC for SUPERSEDED assets; add a daily cloud spend budget | RT-14 → 429 beyond the cap |
| R-06 | F-06 context flooding / relevance | Add a minimum relevance floor; give trusted memory reserved slots (e.g. ≥ 6 of 10); cap untrusted items (≤ 2) | RT-02b: ≤ 2 untrusted in context |
| R-07 | F-07 SDLC / supply chain | Create `main` and protect it (required review + status checks). Add GitHub Actions with pinned action SHAs and least-privilege `permissions:`: typecheck, test, build, `npm audit --omit=dev`, osv-scanner, gitleaks, SBOM artifact. Enable Dependabot or Renovate. Pin Docker base images by digest. Tag phase releases. Address the drizzle-kit dev advisory when a non-breaking path exists | CI must be green on every PR |
| R-08 | F-09 / F-17 audit integrity and coverage | Hash-chain events (each row stores `sha256(prev ‖ row)`); reconcile `productions.status=APPROVED` with a matching `PRODUCTION_APPROVED` event when the gate is checked; emit AUTH_FAILED events; log process executions (binary, arguments with paths redacted, duration, exit code) | RT-05c: SQL-forged approval → gate blocker "approval not attested"; RT-17a |

## P2 — hardening (Low findings)

| # | Finding | Remediation |
|---|---|---|
| R-09 | F-08 symlink escape | Use `realpathSync` + `lstat` (refuse symlinks) in `MediaStore.isFileWithin`; open files with `O_NOFOLLOW` where available |
| R-10 | F-10 confused deputy | Scope `production.write` per artifact kind (`production.write:SCRIPT`, …); allow QA_REPORT only for the QA agent |
| R-11 | F-11 likeness in visual identity | Apply `LIKENESS` and minor checks to human-entered visual identity anchors; require `identity-admin` scope |
| R-12 | F-12 / F-13 headers and errors | Add security headers; return a generic body for 5xx and log details server-side; minimise `/health` |
| R-13 | F-14 token policy | Require ≥ 32 random bytes; support rotation (two valid tokens during rollover) |
| R-14 | F-15 Docker | `read_only: true`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, memory/cpu/pids limits; remove `JOVI_ALLOW_UNAUTHENTICATED_NETWORK` once tokens are mandatory; document ffmpeg's absence |
| R-15 | F-16 unbounded bodies | Stream downloads with byte caps (e.g. 200 MB video, 20 MB image, 50 MB audio) |
| R-16 | F-18 classifier | Add destructive and filesystem verbs (`rm`, `delete`, `wipe`, `format`, `drop`) → LEVEL_5 |
| R-17 | F-19 / F-21 / F-20 trust assumptions | Document the trust model; optional hash-pinning of ffmpeg/say/ffprobe and of approved ComfyUI workflows; a startup warning when ComfyUI or LM Studio is bound beyond loopback |
| R-18 | F-23 data at rest | Retention for events, agent runs and model runs; a backup procedure; FileVault guidance; `0700` permissions on `data/` |
| R-19 | D-11…D-24 documentation drift | Reconcile the Phase 7/8 notes, README "ten planned agents", package description, the `test:production` script and README security wording; commit the ComfyUI IPAdapter workflow for review |

## Suggested sequencing

1. **Security sprint (P0)**: R-01, R-04 (shared auth work), R-02, R-03. Re-run the red-team harness; Gates B, I and J should flip.
2. **SDLC sprint (P1)**: R-07 first (it gates every later change), then R-05, R-06, R-08.
3. **Before Phase 10 (publishing)**: P0 complete, R-08 complete, an independent (human) security review, and a fresh audit of the publishing design (LEVEL_4 tool, per-post human confirmation bound to an authenticated principal, platform token storage in the OS keychain).
