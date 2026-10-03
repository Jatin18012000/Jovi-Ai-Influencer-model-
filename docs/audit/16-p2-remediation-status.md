# 16 — P2 Remediation Status (R-09 … R-19)

Follow-up to `15-p1-remediation-status.md`. Branch `claude/busy-pascal-h6hvhh`, 2026-10-03.

Evidence:
- **Regression tests:** `tests/integration/p2-hardening.test.ts` (16 tests, covering R-09 … R-13 and R-15 … R-18).
- **Container hardening (R-14):** checked by the new CI job **Container (hardened compose)**, which builds the image and asserts the runtime settings on a running container.
- **Red-team re-run:** `docs/audit/poc/redteam-results-after-p2.json`. Earlier runs are kept in `redteam-results.json`, `-after-p0.json` and `-after-p1.json`.
- **Full suite:** 289 passed, 9 skipped. The 9 skipped tests need real LM Studio, ComfyUI, macOS or ElevenLabs.

## What changed

| # | Finding | Implementation | Evidence |
|---|---|---|---|
| R-09 | F-08 symlink escape | `MediaStore.isFileWithin` refuses a symlinked file and requires the file's real path (parents resolved) to be inside the real root. The new `readInput` opens with `O_NOFOLLOW` and re-checks the open descriptor. ComfyUI uploads now take bytes read through `readInput` | RT-09 HELD; test: symlinked file, symlinked directory, read through symlink |
| R-10 | F-10 confused deputy | `production.write` split into `production.write:<KIND>`. Each agent holds only its own kind; only the QA agent holds `production.write:QA_REPORT` | RT-04b HELD (`PermissionDeniedError`) |
| R-11 | F-11 likeness in visual identity | `findAppearanceViolations` (likeness, minor descriptors, ages under 21, explicit content; negation-aware) runs on every human-entered anchor. `apparentAge` must equal the core identity's age (D-19), and the seed takes it from the identity. The route requires `identity-admin` (P0) | RT-19 HELD (likeness → 400) |
| R-12 | F-12/F-13 headers, errors | 5xx bodies are now `{error, message: "Internal error; see the server log", requestId}`; details are logged server-side. Headers and the minimal `/health` were done in P0 | Test: internal path not leaked |
| R-13 | F-14 token policy | Operator tokens need ≥ 32 characters, ≥ 10 distinct characters and an estimated ≥ 128 bits. `JOVI_API_TOKEN_PREVIOUS` is accepted during a rollover (logged once). Stored credentials gain `expires_at`, `--expires-days`, and `rotate` (new `<name>.rN` with the same scopes; the old one expires after a grace period, default 7 days) | Tests: weak tokens rejected, rollover, expiry, rotation |
| R-14 | F-15 Docker | Compose: `read_only`, `tmpfs /tmp`, `cap_drop: ALL`, `no-new-privileges`, 2 GB / 2 CPU / 256 PIDs. Non-root `node` user (unchanged). `.dockerignore` keeps `.env`, `data/` and `node_modules` out of the build context. ffmpeg's absence is documented (D-18). `JOVI_ALLOW_UNAUTHENTICATED_NETWORK` was already removed in P0 | CI job asserts a read-only root, no capabilities, no-new-privileges, the `node` user, a `0600` database, 401 without a token and 403 for a foreign Host |
| R-15 | F-16 unbounded bodies | `readBodyCapped` streams responses and cancels past the cap; a declared oversize `Content-Length` is refused up front. Caps: JSON 10 MB, error snippets 64 KB, image 20 MB, audio 50 MB, video 200 MB. Applied to the model HTTP client, the ComfyUI upload and download, and the ElevenLabs voice lookup and synthesis | Tests: declared and streamed oversize |
| R-16 | F-18 classifier | Destructive and filesystem phrasing → `LEVEL_5_INFRASTRUCTURE`: `rm`/`sudo`/`chmod`/…, delete/wipe/erase/truncate/purge/destroy, formatting a disk, `drop table`, filesystem/reboot. Creator phrasing such as "drop a new reel", "reel format" or "killing it" is unaffected | Test: both directions |
| R-17 | F-19/F-20/F-21 trust | `docs/security/trust-model.md`. Optional SHA-256 pins: `JOVI_FFMPEG_SHA256`, `JOVI_FFPROBE_SHA256` and `MACOS_SAY_SHA256` are checked before every execution (absolute paths required); `COMFYUI_*_WORKFLOW_SHA256` makes a changed workflow `MISCONFIGURED`. Startup warnings when `LM_STUDIO_URL` or `COMFYUI_URL` is not loopback | Tests: pin mismatch refused and match runs; workflow pin; warnings |
| R-18 | F-23 data at rest | The database and its WAL/SHM files are `0600`; the data directory is `0700` (only `data/` or directories Jovi created); media is `0700`/`0600`. Retention: finished agent/model runs after 180 days. Event retention is opt-in: the hash of the last pruned event is stored as a checkpoint (`audit_checkpoints`), the chain verifies from it, the chain continues across it, and pruning is recorded as a `RETENTION_APPLIED` event. Online `--backup` (`0600`, never overwrites). Guide: `docs/security/data-at-rest.md` (FileVault, encrypted backups) | Tests: permissions, pruning and verification, default keeps events, backup; live run on a fresh database: `700`/`600` |
| R-19 | D-11 … D-24 drift | See the table below | — |

### R-19: documentation drift

| Item | Resolution |
|---|---|
| D-11, D-12 | Dated errata appended to the Phase 8 note: LM Studio PASS supersedes the "not run" line; Phase 9 became media generation, and publishing is Phase 10. The original text is kept as the historical record |
| D-13 | Errata appended to the Phase 7 note: last Phase 7 commit `bc98dc9`; Phase 7 was repaired in Phase 8; CI now runs the suite |
| D-14 | README: "Three further agents (publishing, analytics, learning) are registered as planned" |
| D-15 | `package.json` description now covers Phase 9 and P0–P2. The CLI banner "v0.1" matches the package version and is unchanged |
| D-16 | `npm run test:production` now includes media generation, the fake providers, regeneration and the safety-gate suites (95 tests) |
| D-17 | README Security: the process runner, executable-path trust and the pins |
| D-18 | Dockerfile and README: no ffmpeg/ffprobe/`say` in the image, and what that means |
| D-19 | Origin came from the active identity in P0. `apparentAge` is now enforced against the identity (R-11) |
| D-20 | Trends carry a code-assigned `provenance: "MODEL_KNOWLEDGE"`, `verified: false` |
| D-21 | Unchanged: completeness against the original Phase 1–5 specifications cannot be verified from the repository (UNKNOWN) |
| D-22 | **Not done, owner input needed.** No IP-Adapter workflow exists in the repository; it is on the owner's machine. `workflows/README.md` gives the export, placeholder and review checklist, plus pinning. Committing an untested sample would be a fake integration |
| D-23, D-24 | Resolved in P0 (mandatory authentication) and P1 (CI) |

## Red team: after P1 → after P2

| Check | After P1 | After P2 |
|---|---|---|
| RT-04b `production.write` not scoped by kind | VULNERABLE | **HELD** |
| RT-09 symlink escape | VULNERABLE | **HELD** (file, directory and read-through cases) |
| RT-19 likeness text in visual identity | PARTIAL | **HELD** (400) |

**Totals:**

| Run | HELD | VULNERABLE | PARTIAL |
|---|---|---|---|
| Original audit | 14 | 10 | 2 |
| After P0 | 20 | 6 | 1 |
| After P1 | 24 | 2 | 1 |
| **After P2** | **27** | **0** | **0** |

Every check in the harness now holds. The harness covers the attacks it was written for; it does not prove the absence of others.

## Security gate: after P1 → after P2

| Gate | After P1 | After P2 | Basis |
|---|---|---|---|
| A | PASS | PASS | — |
| B | PASS | PASS | Plus generic 5xx bodies (F-13) |
| C | CONDITIONAL PASS | CONDITIONAL PASS | Unchanged. Tail-append forgery by a local database writer is detectable only by recording the chain head externally (runbook §6) |
| **D** | CONDITIONAL PASS | **PASS** | Artifact-scoped writes close the confused deputy (RT-04b). In-process enforcement (F-19) is documented as an accepted trust assumption: first-party agents, models never choose tools |
| E | PASS | PASS | Optional executable pins |
| **F** | CONDITIONAL PASS | **PASS** | Symlink escape closed (RT-09); reads use `O_NOFOLLOW` |
| G | PASS | PASS | gitleaks: no leaks |
| H | PASS | PASS | 0 runtime advisories |
| I | PASS | PASS | — |
| J | CONDITIONAL PASS | CONDITIONAL PASS | Unchanged. The safety review still needs a real-model validation |
| K | PASS | PASS | Retention keeps the chain verifiable (checkpoints, `RETENTION_APPLIED`) |
| L | CONDITIONAL PASS | CONDITIONAL PASS | Unchanged. The owner must create and protect `main` |

**Overall: CONDITIONAL PASS.** The remaining conditions are owner or real-world steps, not code:
1. Protected `main` with the required checks (L).
2. A real-model run of the safety review (J).
3. External anchoring of the audit head before publishing (C).

**CSO answer:** unchanged from P1. **Yes, conditionally, for attended, human-approved local production** once 1 and 2 are done. **No** for unattended production and for Phase 10 publishing until 3 is done, an independent human security review has taken place, and the publishing design has been audited.

## CI status

Recorded after the push in the final report for this change.

## Not done

- **D-22:** the ComfyUI identity workflow must come from the owner (see `workflows/README.md`).
- **Owner steps** (runbook): `main`, branch protection, repository security settings, tags.
- **Real-model validation** of the safety review (Gate J).
- The 9 skipped real-provider tests, which need LM Studio, ComfyUI, macOS `say` or ElevenLabs on the owner's machine.
