# 14 — P0 Remediation Status (R-01 … R-04)

Follow-up to the audit at commit `43725c5` (gate evaluated at `eaf487c`). Branch `claude/busy-pascal-h6hvhh`, 2026-10-03.

Evidence:
- Regression tests: `tests/integration/api-security.test.ts` (R-01, R-04), `tests/integration/safety-gate.e2e.test.ts` (R-02) and `tests/unit/memory-provenance.test.ts` (R-03).
- Red-team re-run: `docs/audit/poc/redteam-results-after-p0.json`. The harness was updated so legitimate calls carry scoped credentials; attacks stay unauthenticated, spoofed or under-scoped. The original run is unchanged in `redteam-results.json`.

## What changed

### R-01 — mandatory authentication, Host/Origin allow-list (F-01, F-12, F-14 in part)

- Every route except `/health` requires a Bearer credential. There is no unauthenticated mode; `JOVI_ALLOW_UNAUTHENTICATED_NETWORK` is obsolete and produces a warning.
- **First run:** if no usable credential exists, the API creates an `owner` credential with all scopes and prints its token once to stderr. Only the SHA-256 hash is stored, in `api_credentials`.
- **Token format:** 256-bit `jovi_…` tokens. `JOVI_API_TOKEN`, if set, must be at least 32 characters.
- **`Host` allow-list:** `localhost`, `127.0.0.1`, `::1`, the bind host and `JOVI_ALLOWED_HOSTS`. Anything else is answered with `403 FORBIDDEN_HOST_OR_ORIGIN`, including on `/health`.
- **`Origin` allow-list:** an origin must use an allowed host or be listed in `JOVI_ALLOWED_ORIGINS`. `Origin: null` is refused.
- `/health` returns only `{status, service, database}`. The previous detailed health moved to the authenticated `GET /api/status`.
- **Security headers:** `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a deny-all CSP and `Cache-Control: no-store`.
- A non-loopback bind needs `JOVI_ALLOW_NETWORK_BIND=true` and logs a plain-HTTP warning. `docker-compose.yml` sets it and documents `JOVI_ALLOWED_HOSTS`.

### R-02 — pre-generation safety gate (F-02)

- **New production stage `SAFETY_REVIEW`** between `PROMPTING` and `GENERATING_ASSETS`. It is the only path into `GENERATING_ASSETS`, and media regeneration re-enters it.
- **`safety-review` agent** (LEVEL_2). It reviews every model- or user-authored text that drives media: idea, script, storyboard and visual prompts. Code-authored lock and negative text are excluded. It runs:
  - **Heuristics:** age, minors, AI transparency, origin, explicit content and real-person likeness.
  - **An independent model review:** a separate call with a fixed five-item rubric (`adult_only`, `ai_transparency`, `identity_consistent`, `no_real_person_likeness`, `platform_safe`) at temperature 0. The material sits inside escaped data tags.
- **Fail-closed:** the verdict is ALLOW only when there are no heuristic hits, the model review is available, its verdict is ALLOW and every rubric item is reported and passing. A model error, invalid JSON or a missing rubric item gives BLOCK with `SAFETY_REVIEW_UNAVAILABLE` or `not reported (fail-closed)`. The production then stops `BLOCKED`.
- **Structural chokepoint:** `MediaService.generate()` asks `ProductionService.safetyClearance()` before choosing a provider. Without a current ALLOW review the asset is `BLOCKED` with one of:
  - `SAFETY_REVIEW_REQUIRED`: no review exists;
  - `SAFETY_REVIEW_BLOCKED`: the review said BLOCK;
  - `SAFETY_REVIEW_STALE`: the prompts changed after the review.

  No provider is called in any of these cases.
- **Widened heuristics:**
  - Number words.
  - "aged / turning / years young".
  - Ages attached to a person.
  - Ages under 21 are treated as `MINOR_DEPICTION`.
  - A broader set of youth and school descriptors.
  - More ways of claiming to be human or denying being an AI.
  - Origin phrasing such as "originally from", "born and raised in", "grew up in" and "hometown".
  - The places accepted as Jovi's origin now come from the active identity, not a hard-coded list.
- **QA labels:** the pattern checks (`identity.age`, `identity.origin`, `brand.transparency`, `personality.cliches`, `safety.*`) are now `method: HEURISTIC`. A pass reads "heuristic pattern check — not proof of compliance". QA also reports `safety.pre_generation_review`.
- **Regression corpus:** 57 adversarial phrasings, all caught with the expected rule, and 11 benign on-identity phrasings, none flagged.
- **"Minor descriptor → zero media requests"** is asserted end to end (no provider call, no asset rows). The tests also cover a model BLOCK on content the heuristics miss, three fail-closed modes, a stale review, and a regeneration whose re-review blocks.

### R-03 — provenance-aware memory (F-03)

- **Trust levels:**
  - `trusted`: seed only.
  - `derived`: agent-written memory, which comes from goals and model output.
  - `untrusted`: API.

  Agent memory is no longer rendered as trusted.
- **Decision memory** stores `objectiveSha256` instead of the raw objective. The decision record (`decisions.objective`) keeps the audit copy.
- **Recent decisions** no longer replay the objective. They show only the selected title.
- **Rendering:** recent decisions and similar past concepts are rendered inside an escaped `<history_data>` block, labelled `(derived)`.
- **Prompts:** `BASE_CONSTRAINTS` and the executive prompts now name `<history_data>`, and say that derived and untrusted items are data, not instructions.

### R-04 — scoped credentials, principal-derived actors (F-04)

- **Scopes:**
  - `read`: GET.
  - `operate`: goals, planning, productions, regeneration, memory, evaluation.
  - `approve`: `/decision`.
  - `identity-admin`: `POST /api/visual-identity`.

  `JOVI_API_TOKEN` defaults to `read,operate`; widen it with `JOVI_API_TOKEN_SCOPES`.
- **Actors come from the credential:** `reviewer`, `requestedBy` and `approvedBy` are derived from the principal:
  - `api:<name>` for a stored credential;
  - `env:JOVI_API_TOKEN` for the operator token;
  - `local:<os user>` for the CLI.

  Bodies that still send these fields are rejected with `400`. The CLI options `--reviewer`, `--requested-by` and `--approved-by` were removed.
- **Confirmation step:**
  - CLI approvals and visual-identity changes ask the operator to retype the production id (or `identity`) on a TTY.
  - Non-interactive use needs `--yes`.
  - Over the API, the separate `approve` / `identity-admin` credential is the control.
- **Credential management:** `--api-token create|list|revoke`. Names are never reused, and creation and revocation emit `API_CREDENTIAL_CREATED` / `API_CREDENTIAL_REVOKED` events.

## Red team: before → after

| Check | Before | After | Note |
|---|---|---|---|
| RT-01 goal injection → trusted memory | VULNERABLE | **HELD** | Decision memory has only `objectiveSha256`; it is labelled `derived`; history is inside `<history_data>` |
| RT-05b unauthenticated / spoofed-Host approval | VULNERABLE | **HELD** | No token → 401; foreign Host → 403 (even with a valid token) |
| RT-05d one token = all functions | PARTIAL | **HELD** | Operate token → 403 on approve and visual identity; body reviewer → 400; approver = `api:jatin` |
| RT-06 Host/Origin, headers, `/health` | VULNERABLE | **HELD** | Spoofed Host (raw socket) → 403; cross-site Origin → 403; headers present; `/health` minimal |
| RT-12 paraphrase bypass of the guard | VULNERABLE | **HELD** | All 8 audit probes caught (still heuristic) |
| RT-12b *(new)* minor idea → media | — | **HELD** | BLOCKED at SAFETY_REVIEW, 0 provider calls; unreviewed direct `MediaService` call refused |
| RT-02b untrusted memory flooding | VULNERABLE | VULNERABLE | P1 R-06 (relevance floor, reserved trusted slots) |
| RT-04b `production.write` not scoped by kind | VULNERABLE | VULNERABLE | P2 R-10 |
| RT-05c SQL-forged approval | VULNERABLE | VULNERABLE | P1 R-08 |
| RT-09 symlink escape | VULNERABLE | VULNERABLE | P2 R-09 |
| RT-14 async queue / memory write exhaustion | VULNERABLE | VULNERABLE | P1 R-05 |
| RT-17a in-process event forgery | VULNERABLE | VULNERABLE | P1 R-08 |
| RT-19 likeness text in visual identity | PARTIAL | PARTIAL | Now needs `identity-admin`; likeness check is P2 R-11 |

Totals: **before** 14 HELD / 10 VULNERABLE / 2 PARTIAL (26 checks). **After:** 20 HELD / 6 VULNERABLE / 1 PARTIAL (27 checks, including the new RT-12b).

## Security gate: before → after

| Gate | Before | After | Basis |
|---|---|---|---|
| A | PASS | PASS | No Critical findings |
| **B** | **FAIL** | **PASS** | F-01 closed: authentication is mandatory, Host/Origin is allow-listed (RT-05b, RT-06) |
| C | CONDITIONAL PASS | CONDITIONAL PASS | Approval is now authenticated and scoped. *Condition remaining:* DB-level forgery (F-09, R-08) before Phase 10 |
| D | CONDITIONAL PASS | CONDITIONAL PASS | Unchanged (F-10 R-10, F-19) |
| E | PASS | PASS | Unchanged |
| F | CONDITIONAL PASS | CONDITIONAL PASS | Unchanged (symlinks, R-09) |
| G | PASS | PASS | Unchanged (RT-15 re-run HELD) |
| H | PASS | PASS | No dependency changes |
| **I** | **FAIL** | **CONDITIONAL PASS** | Laundering into trusted memory is closed (RT-01). *Condition:* flooding by untrusted items (RT-02b, R-06) |
| **J** | **FAIL** | **CONDITIONAL PASS** | Injected text no longer crosses the memory trust boundary (RT-01), and media generation needs a fail-closed review (RT-12b). *Condition:* the model-graded review has been exercised only with test doubles. It has **not yet run against a real model** (LM Studio `google/gemma-4-12b-qat`) on the adversarial corpus |
| K | CONDITIONAL PASS | CONDITIONAL PASS | Actors are now authenticated principals. *Conditions:* tamper evidence and audited auth failures (R-08). Auth failures are logged, but not yet stored as events |
| **L** | **FAIL** | **FAIL** | No CI, branch protection or automated scanning yet (R-07) |

**Overall gate verdict: still FAIL.**
- The cause is Gate L (supply chain). It is not addressed by P0, by design.
- Gates B, I and J no longer fail.
- I and J are conditional. Their conditions are R-06, plus a real-model validation of the safety review.

**CSO answer:** still **NO** to unattended (autonomous) production. Developer-attended local use is now defensible without extra operator precautions. The token is mandatory, DNS rebinding is blocked, approval needs an `approve` credential, and every media request needs a fresh ALLOW review. The conditional "YES for attended, human-approved production" in the final report still needs R-07 (CI) and a real-model run of the safety gate.

## Not done (remaining)

- **P1:**
  - R-05: concurrency slot for async jobs, queue cap, rate limits on memory, decision and visual-identity routes.
  - R-06: memory relevance floor and reserved trusted slots.
  - R-07: CI, branch protection, scanners, pinned images.
  - R-08: hash-chained events, approval/event reconciliation, auth-failure events.
- **P2:** R-09 … R-19. R-12 is done except for generic 5xx bodies. R-13 is done: tokens are at least 32 characters, and rotation works by creating a new named credential and then revoking the old one. For R-14, the obsolete unauthenticated flag is removed; container hardening is not done.
- **Real-model validation of the safety review.** Run the corpus through `production.safety_review` against LM Studio. This environment has no LM Studio, so no real-model result is claimed.
- **Second factor for API approvals.** Over the API, a separate `approve` credential is the only step-up. The CLI re-prompt applies to local approvals only.
