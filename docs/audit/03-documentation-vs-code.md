# 03 — Documentation vs Implementation

The requirements sources examined were:
- `README.md` and `docs/phase-6…9-*.md`
- the NotebookLM notes
- `knowledge/jovi/*.md` (the only in-repository remnants of the Phase 1–5 identity, character, content and visual specifications)
- `.env.example`, code comments, and the architectural principles stated in the audit brief

**The Phase 1–5 specifications themselves are not in the repository.** Only their derived knowledge files and seed data are (`src/database/seed/identity.ts`, `memories.ts`). Requirements that exist only in those external documents are marked **UNKNOWN**.

Every mismatch below is a **DOC-CODE-MISMATCH**; the subtype is in the second column.

| # | Subtype | Documentation says | Code actually does | Evidence | Impact |
|---|---|---|---|---|---|
| D-01 | Security control documented, not enforced | "Publishing remains human-gated"; "Only `recordHumanDecision` … can set APPROVED" (README, Phase 8/9 notes) | Approval is reachable by **any API caller** (no token by default) with a free-text reviewer; it is "API-caller-gated", not human-gated | `server.ts:200-206`, `production-service.ts:53`; RT-05b | High (F-01, F-04) |
| D-02 | Security control documented stronger than enforced | M1: "External memory … untrusted … cannot overwrite seed/agent memory" (Phase 6 architecture) | True for direct writes, but user text is **laundered into trusted agent memory** via the executive's DECISION/CONTENT writes; this is not documented | `executive-agent.ts:193-240`; RT-01 | Medium (F-03) |
| D-03 | Security control documented stronger than enforced | Phase 9: outputs and references are "confined to `JOVI_MEDIA_DIR` / `JOVI_REFERENCE_DIR`" | Lexical `resolve()` checks; **symlinks are followed** | `media-store.ts:60-64`; RT-09 | Low (F-08) |
| D-04 | Security control documented stronger than enforced | README: "Expensive endpoints are rate limited … and capped in concurrency" | Async productions release the slot immediately (unbounded queue); memory, decision and visual-identity are unthrottled | `server.ts:154-160`; RT-14 | Medium (F-05) |
| D-05 | Test claim stronger than coverage | Phase 8/9 notes: tests prove the "human approval boundary" | Tests prove that *pipeline code* cannot approve. They do not (and cannot) prove a *human* approved, because no principal model exists | `tests/integration/*`; RT-05 | Medium |
| D-06 | Test claim stronger than coverage | Phase 8: "identity is immutable"; QA "identity.age PASSED" | The deterministic guard and QA use regexes that miss paraphrases (6 of 8 probes) | `identity-guard.ts:11-15`, `rule-checks.ts:70`; RT-12 | High (F-02) |
| D-07 | Architecture principle missing | "Database + Markdown + **embeddings**" | No embeddings: `KeywordSemanticMemory` (lexical). The context even reports "(lexical, not vector)" | `src/memory/semantic/semantic-memory.ts:33`; `context-engine.ts:155` | Functional |
| D-08 | Documented capability missing | "n8n as automation layer" | `n8n.trigger` is registered in the tool registry with **no implementation** and no agent can run it; the event bus comment mentions n8n webhooks that do not exist | `permissions.ts:55`, `event-bus.ts:49` | Low (dead registry entry) |
| D-09 | Dead code | `task.create` tool (LEVEL_3) | Registered, but granted to no agent and with no ToolKit method | `permissions.ts:49`; `toolkit.ts` | Informational |
| D-10 | Dead / inconsistent code | ToolKit `media.videoNeedsSourceImages(aspectRatio)` | Unused by agents. The pipeline calls `MediaService` directly with privacy; the ToolKit version ignores privacy | `toolkit.ts:153` vs `production-pipeline.ts:351` | Informational |
| D-11 | Stale phase boundary / contradictory notes | Phase 8 note: "Phase 9 would cover the publishing workflow" | Phase 9 was implemented as media generation; the Phase 9 note says publishing is Phase 10 | `docs/phase-8-notebooklm-project-note.md:133` vs `docs/phase-9-notebooklm-project-note.md` | Governance confusion |
| D-12 | Contradictory content inside one note | Phase 8 note, top: "the Phase 8 text agents have not yet been run against a real LM Studio model" | The same file's appended section records a real LM Studio PASS (2/2) | `docs/phase-8-notebooklm-project-note.md:6` vs the final section | Low |
| D-13 | Stale documentation | Phase 7 note: "14 commits ahead…; latest Phase 7 documentation commit `c527b5c`"; "source changes still require a local npm test…" | Phase 7 was later repaired in Phase 8 (it did not build when committed); the last Phase 7 commit is `bc98dc9` | `docs/notebooklm-phase-7-note.md:6,47` | Low |
| D-14 | Stale documentation | README "What's inside": "Ten further agents are registered as *planned*" | 3 planned agents (publishing, analytics, learning); 13 active | `README.md:176`; `planned-agents.ts` | Low |
| D-15 | Stale metadata | `package.json` description lists Phases 6–8; CLI banner "Jovi Core v0.1 CLI"; `/health` version `0.1.0` | Phase 9 code present | `package.json:5`, `cli.ts:12`, `server.ts:108` | Low |
| D-16 | Stale tooling | `npm run test:production` (README) | Excludes the Phase 9 suites (`media-generation`, `media-providers-fake`, `media-regeneration`) | `package.json` scripts | Low |
| D-17 | Code capability not documented | README Security: "There are no shell, filesystem … tools" | True for agents, but the system spawns ffmpeg, ffprobe and `say` (Phase 9). The README Security section does not mention the process runner or the executable-path trust | `process-runner.ts`; `README.md:166` | Low |
| D-18 | Documented capability unavailable in a deployment mode | Phase 9: ffmpeg render provider; README Docker section | The Docker image contains no ffmpeg, so the render provider is always NOT_CONFIGURED in the container (undocumented) | `docker/Dockerfile` | Functional |
| D-19 | Duplicated source of truth | M3: "identity comes from the active identity version" | `identity-guard.ts:39` hard-codes London/UK origins; `visual-identity.ts:38` hard-codes `apparentAge: 25` | RT / code review | Low (regression; see 11) |
| D-20 | Requirement partially implemented | "Agents must not fabricate live web/social data" | Research `sourceType` excludes live web ✔. Trends `freshness: 'CURRENT'` and free-text `signal` let a model assert current trends with no provenance field | `planning-agents.ts:13,30` | Medium (integrity) |
| D-21 | Requirement documented, unverifiable | Phase 1–5 identity, character, content and growth specifications | Only the knowledge files and seed data are present; their completeness against the original specifications cannot be verified | `knowledge/jovi/*`, `src/database/seed/*` | UNKNOWN |
| D-22 | Architecture says ComfyUI identity workflow (IPAdapter) | Phase 9 docs reference reference-image conditioning ("e.g. IP-Adapter/PuLID") | No workflow is committed (`workflows/.gitkeep`); only generic `{{REFERENCE_IMAGE}}` support exists | `comfyui-providers.ts`; `workflows/` | NOT_TESTABLE |
| D-23 | Documented secure default not secure by default | README Quick start copies `.env.example` (empty `JOVI_API_TOKEN`) | The default run is unauthenticated on loopback; the README never states that local processes and browsers (DNS rebinding) can reach it | `.env.example:101`, `README.md` | High (F-01) |
| D-24 | GitHub / DevSecOps principle | Architecture lists GitHub as part of the stack (implying a review/CI workflow) | No CI, no default branch, no protection | `.github/` absent | Medium (F-07) |

## Verified matches (no mismatch)

- LM Studio is the sole local runtime; no Ollama path (`config.ts:103-105` only warns).
- Mock never mixes with real providers (model and media registries).
- No autonomous publishing code exists anywhere; `autonomousPublishingAllowed` is always `false`.
- Strategy changes are proposals only. `StrategyService.createVersion` has no caller outside the seed.
- Core identity has no write route and no agent tool.
- Models cannot invoke tools; the ToolKit enforces allow-lists and levels (RT-03, RT-04).
- No automatic download of models, packages, workflows or scripts (code review).
- Modular monolith; no microservices introduced.
