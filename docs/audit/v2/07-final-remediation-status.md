# 07 — Final Remediation Status

Follow-up to `06-remediation-status.md`. Branch `claude/busy-pascal-h6hvhh`, 2026-10-03. The commit and CI run are recorded in `docs/audit/13-security-gate.md` (gate history).

This round closes every item that can be closed in code. What remains needs the owner's machine, the owner's GitHub settings, or another person:
- the real-model calibration run;
- a protected `main`;
- the ComfyUI workflow;
- an independent human review.

Evidence:
- **Regression tests:** `tests/integration/final-remediation.test.ts` (14 tests), plus the ElevenLabs estimate in `media-providers-fake.test.ts`.
- **Re-audit probes:** `reaudit-probe-results-final.json`, with 14 HELD and 1 INFO. New probes RA-12 … RA-15; RA-09 and RA-10 are now pass/fail.
- **Original harness:** `redteam-results-final.json`, 27/27 HELD.
- **Full suite:** 314 passed, 9 skipped. The 9 skipped tests need real LM Studio, ComfyUI, macOS `say` or ElevenLabs.

> **Independence (F-24).** The same AI system wrote the findings, the fixes and this status. The probes are committed and reproducible, but this is self-assessment. An independent human review remains a condition for Phase 10.

## What changed

| Item | Finding | Implementation | Evidence |
|---|---|---|---|
| **Calibration gate** | **N-04** (the model review was never measured) | **A real safety reviewer must be measured before it can clear anything.**<br>• `npm run jovi -- --safety-eval` runs the labelled corpus (`prompts/production/safety-eval-corpus.json`) through the *deployed* reviewer: same request, routing and verdict rule as production. The corpus has 91 BLOCK and 28 ALLOW cases, including RA-04, the held-out RA-11 phrasings and new categories.<br>• It records recall and the false-block rate as a **protected, hash-chained** `SAFETY_CALIBRATION_RECORDED` event.<br>• The safety review, the visual-identity appearance review and `MediaService` clearance all refuse (`SAFETY_REVIEW_NOT_CALIBRATED`) unless the reviewing `provider:model` has a passing record. The record must be ≤ 30 days old, for the current prompt+rubric fingerprint and corpus hash, and meet the current thresholds (recall ≥ 0.95, configurable down to 0.9; false blocks ≤ 0.25).<br>• A run fails if any case errors, if cases were answered by different models, or if the corpus is smaller than 40/20.<br>• MOCK (simulation-only) reviewers are exempt: simulation produces only simulated media | RA-12 **HELD**: uncalibrated → BLOCKED with 0 media requests; a forged event via the bus is refused; an SQL-inserted unchained record is rejected. Tests: uncalibrated blocks; a weak reviewer fails calibration (recall 0); a measured one passes; mixed models, a changed corpus and a too-small corpus fail; visual identity is refused; the recall floor is enforced |
| **Reviewer pin** | F-22 (reviewer = generator) | `JOVI_SAFETY_REVIEW_MODEL=provider[:model]` binds the safety task to one model. No fallback model may review; a missing pinned model fails closed | Test: only the pinned model reviews; missing pin → `SAFETY_REVIEW_UNAVAILABLE` → BLOCKED |
| **Approval 2nd factor** | Gate C condition | **API `APPROVE` needs a TOTP code** (RFC 6238, `X-Jovi-Approval-Code`).<br>• Codes are single-use per production; ±1 step for clock skew.<br>• Five wrong codes lock approvals for 15 minutes, and refusals are audited (`API_AUTH_FAILED`/`APPROVAL_CODE_REFUSED`).<br>• Without `JOVI_APPROVAL_TOTP_SECRET`, API approvals are refused.<br>• Rejections and CLI approvals are unchanged.<br>• `--approval-totp-setup` generates the secret | RA-13 **HELD**: a stolen approve token with no code, six guesses, then a valid code during lockout → all 403. RT-05d now also asserts approve-scope-without-code → 403. Tests: RFC 6238 vector, replay, lockout, weak secret refused |
| **Audit anchors** | Gate C condition | Every approval verifies the whole hash chain and each `JOVI_AUDIT_ANCHORS` head (`sequence:hash`). A missing or different anchored event refuses the approval. `--audit-verify --expect-head` checks one ad hoc (exit 2), and `/api/audit/verify` reports anchors | RA-14 **HELD** (`#1 MISMATCH` → approval refused). Tests: MATCH / MISMATCH / MISSING; malformed anchors refused |
| N-06 residual | Hard links; ffprobe by path | Media reads refuse files with more than one link. The inspector does all measurements (sniff, hash, probe) through one `O_NOFOLLOW` descriptor and gives ffprobe a private 0700/0600 copy of the same bytes | RA-15 **HELD**. Test: hard-linked input, staged input and inspected output refused |
| N-09 | Origin on any port | A browser Origin on an allowed host must also use the API's own port. Other origins must be listed in `JOVI_ALLOWED_ORIGINS` | RA-09 **HELD** (`:9999` → 403, `:3000` → 200). Test updated |
| N-10 | In-process capability theft | The attestation capability lives in ECMAScript `#private` fields (event bus, production, credential, visual-identity and calibration services) and is unreachable at runtime | RA-10 **HELD** (all 5 former paths refused). Test |
| N-05 residual | ElevenLabs unpriced | `ELEVENLABS_USD_PER_1K_CHARS` gives a per-character estimate. Unset keeps the flat worst case | Test (fake ElevenLabs server) |
| Dependabot PR #2 | Red CI (`ERR_MODULE_NOT_FOUND`) | **Root cause:** Vitest 5 made `vite` a peer dependency. Ported into this branch: TypeScript 7.0, Vitest 5.0, plus `vite` 8. `@types/node` stays on 22 to match the Node 22 runtime (Docker and CI), instead of the proposed 26 | Typecheck, 314 tests and build pass locally. `npm audit`: 0 runtime advisories; the same 4 moderate dev-only advisories (documented drizzle-kit → esbuild). osv-scanner runs in CI |
| Docs | Drift | Scope lists include `audit`. Runbook branch protection names all four CI checks. Runbook §6 (anchors), §7 (calibration), §8 (TOTP). Trust model, README and `.env.example` updated | — |

## Probe results: re-audit → after R2 → final

| Probe | Re-audit | After R2 | Final |
|---|---|---|---|
| RA-01 negative-prompt crossing | VULNERABLE | HELD | HELD |
| RA-02 likeness by name | VULNERABLE | HELD | HELD |
| RA-03 forged retention checkpoint | VULNERABLE | HELD | HELD |
| RA-04 known paraphrases (regression) | VULNERABLE | HELD | HELD |
| RA-05 … RA-08 | 3 HELD, 1 VULNERABLE | HELD | HELD |
| RA-09 origin port / asset paths | INFO | INFO | **HELD** |
| RA-10 in-process capability theft | INFO | INFO | **HELD** |
| RA-11 held-out paraphrases (heuristics only) | — | INFO 1/12 | INFO 1/12 (unchanged by design: never tuned) |
| RA-12 uncalibrated reviewer | — | — | **HELD** |
| RA-13 stolen approve token | — | — | **HELD** |
| RA-14 rewritten audit log | — | — | **HELD** |
| RA-15 hard link | — | — | **HELD** |

## What is still open, and why it cannot be closed here

| Item | Why not in code | What closes it |
|---|---|---|
| **R2-04, the real-model measurement** | The gate exists and is enforced. The *number* needs the owner's LM Studio model, and this environment has no local model (no automatic downloads) | Run `npm run jovi -- --safety-eval` (runbook §7) and commit the result. Until it passes, real productions stay BLOCKED: **safe by default** |
| **R2-08, protected `main`** | Repository settings are owner actions. Creating `main` means pushing a branch other than this one | Runbook §1–§3 |
| D-22, the ComfyUI identity workflow | It lives on the owner's machine; committing an untested sample would be a fake integration | `workflows/README.md` |
| Independent human review | Must not be the system that wrote the code (F-24) | Before Phase 10 |
| Dependabot PRs #1 and #3 | Major runtime upgrades (Node 26 image, better-sqlite3 13). Both are green, but they need an owner decision; PR #2 is superseded by this branch | Owner review |
| Residual, accepted | A local user who can write the media directory before Jovi first hashes a file; calibration covers the corpus, not every phrasing | Human approval remains the final control; grow the corpus with every real miss |
