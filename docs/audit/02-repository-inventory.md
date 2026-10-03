# 02 — Repository Inventory

Audit baseline: commit `eaf487cf05ea4f1c1db44b0ea196b89199e886ce`, branch `claude/busy-pascal-h6hvhh`, audit date 2026-10-03.
All facts below were read from the working tree and `git`, not from earlier reports.

## 1. Git state

| Item | Observed |
|---|---|
| Current branch | `claude/busy-pascal-h6hvhh` (the only local branch) |
| HEAD | `eaf487c` "Phase 9: NotebookLM project note (real media generation)" |
| Remote refs | `origin/HEAD` and `origin/claude/busy-pascal-h6hvhh` both at `eaf487c` — **no `main`/default branch, no other branches** |
| Local vs remote | 0 ahead / 0 behind (no divergence) |
| Working tree before the audit | clean |
| Tags | **none** — Phase 6–9 boundaries are identifiable only by commit message |
| Commits | 21 total; root `da94859` |
| Authors | `Claude <noreply@anthropic.com>` (Phase 6, 6-hardening, 8, 8-note, 9, 9-note) and `Jatin18012000 <paljatin07@gmail.com>` (Phase 7, 15 commits) |
| Repository size | 2.1 MiB loose objects; no large binaries, no generated media, no databases committed |
| History rewriting | not detectable from a fresh clone; not attempted |

Phase boundaries (by message):

| Phase | Commits |
|---|---|
| 6 core brain | `da94859` |
| 6 hardening (LM Studio only, security fixes) | `802bb4b` |
| 7 planning | `54c6998` … `bc98dc9` (15 commits) |
| 8 creative production | `b698447`, note `fa032ea` |
| 9 real media generation | `8338784`, note `eaf487c` |

## 2. Source inventory (163 tracked files)

| Area | Files | Notes |
|---|---|---|
| `apps/api` | `main.ts`, `server.ts`, `security.ts` | Fastify API, bind guard, rate limiter |
| `apps/orchestrator` | `cli.ts`, `worker.ts` | CLI, background job worker |
| `apps/dashboard` | `README.md` only | planned, no code |
| `src/agents` | 15 files | agent contract, runner, ToolKit, registry, executive, planning, production |
| `src/core` | 26 files | bootstrap, config, errors, events, identity, jobs, orchestrator, permissions, production, prompts, strategy, decisions |
| `src/database` | 16 files | Drizzle schema, client, 3 migrations + snapshots, seed |
| `src/media` | 11 files | provider contract, registry, store, inspector, process runner, providers |
| `src/models` | 14 files | router, provider registry, cloud/LM Studio/mock providers, evaluator, pricing |
| `src/memory` | 4 files | operational (SQLite), knowledge (Markdown), semantic (lexical), text utils |
| `src/integrations` | 3 files | `lmstudio/`, `comfyui/`, README |
| `prompts/` | 11 files | system, executive, evaluation, production, agents README |
| `knowledge/jovi/` | 5 files | character bible, content strategy, privacy boundaries, visual bible, voice guide |
| `tests/` | 28 files | 15 unit, 9 integration, 3 fakes, helpers |
| `docs/` | 8 files (before this audit) | phase 6–9 architecture and NotebookLM notes |
| Config | `package.json`, `package-lock.json`, `.npmrc`, `tsconfig*.json`, `vitest.config.ts`, `drizzle.config.ts`, `.env.example`, `.gitignore` | |
| Container | `docker/Dockerfile`, `docker-compose.yml` | |
| CI | **none** (no `.github/`) | |
| Empty placeholders | `workflows/.gitkeep`, `experiments/.gitkeep`, `data/.gitkeep` | no ComfyUI workflow is committed |

## 3. Tests (28 files)

| Kind | Files |
|---|---|
| Unit | `context-permissions`, `decisions-evaluator`, `event-bus`, `executive`, `hardening`, `identity`, `lmstudio-provider`, `memory`, `planning`, `providers`, `router`, `tasks-jobs`, `production-contracts`, `media-providers`, `media-generation` |
| Integration (in-process / fake servers) | `api.e2e`, `goal-flow.e2e`, `lmstudio-flow.e2e`, `production-pipeline.e2e`, `media-regeneration.e2e`, `media-providers-fake` |
| Real (opt-in, skipped by default) | `lmstudio.real`, `production.real`, `media.real` |
| Fakes | `fake-lmstudio.ts`, `fake-media.ts`, `production-fixtures.ts` |

Baseline in this environment: `npm run typecheck` PASS, `npx vitest run` 227 passed / 9 skipped, `npm run build` PASS. **These results are not used as security evidence.**

## 4. API routes (21) — `apps/api/server.ts`

| Method | Path | Line | State-changing | Rate-limited |
|---|---|---|---|---|
| GET | `/health` | 102 | no | no (and **unauthenticated even with a token**) |
| GET | `/api/jovi/identity` | 123 | no | no |
| GET | `/api/jovi/strategy` | 134 | no | no |
| POST | `/api/jovi/goal` | 136 | yes (task, job, decision, memory) | yes |
| POST | `/api/jovi/planning` | 147 | yes (task, model calls) | yes |
| POST | `/api/productions` | 154 | yes (task, job, production, media) | yes (sync only; see F-05) |
| GET | `/api/productions/:id` | 162 | no | no |
| GET | `/api/productions/:id/{script,storyboard,visual-prompts,edit-plan,qa}` | 175 | no | no |
| GET | `/api/productions/:id/assets` | 184 | no | no |
| GET | `/api/productions/:id/publishing-gate` | 190 | no | no |
| POST | `/api/productions/:id/decision` | 200 | **yes — human approval** | **no** |
| POST | `/api/productions/:id/regenerate-media` | 212 | yes | yes |
| GET | `/api/media/providers` | 219 | no (probes providers) | no |
| GET | `/api/visual-identity` | 231 | no | no |
| POST | `/api/visual-identity` | 237 | **yes — identity version** | **no** |
| GET | `/api/jovi/goal/:id` | 244 | no | no |
| GET | `/api/tasks/:id`, `/api/jobs/:id`, `/api/decisions/:id` | 251–262 | no | no |
| GET | `/api/events` | 267 | no | no |
| POST | `/api/memory` | 283 | yes (untrusted memory) | **no** |
| GET | `/api/memory` | 290 | no | no |
| GET | `/api/models`, `/api/agents` | 304, 324 | no | no |
| POST | `/api/evaluate` | 332 | yes (model calls) | yes |

Global: `bodyLimit` 256 KiB (line 59); optional bearer token hook (line 74); no CORS plugin, no security headers, no Host/Origin validation, no request/connection timeout.

## 5. CLI (`apps/orchestrator/cli.ts`)

Positional goal; `--simulate --local-only --json --tier --providers --identity --plan --produce --from-plan --idea --aspect-ratio --production --decide --decision --reviewer --acknowledge-warnings --regenerate-media --requested-by --kinds --include-completed --visual-identity --set-visual-identity --approved-by --summary --help`. The CLI has **no authentication**: whoever can run it on the host can approve, regenerate and change the visual identity.

## 6. Agents and permissions

| Agent | Status | Level | Allowed tools |
|---|---|---|---|
| executive | ACTIVE | LEVEL_2 | identity/strategy/memory/knowledge/decision/agent read, model.generate, model.evaluate, decision.write, memory.write |
| research, trends, strategy, ideation | ACTIVE | LEVEL_1 | identity/strategy/memory/knowledge/decision read, model.generate |
| script, storyboard, visual-prompt, qa | ACTIVE | LEVEL_2 | identity/strategy/knowledge read, production.read, production.write, model.generate |
| image-generation / video-generation / voice | ACTIVE | LEVEL_3 | identity.read, production.read, one `media.*.generate` |
| editing | ACTIVE | LEVEL_3 | production.read, production.write, media.edit.render |
| publishing | PLANNED | LEVEL_4 | social.publish, n8n.trigger (not runnable) |
| analytics / learning | PLANNED | LEVEL_1 / LEVEL_2 | not runnable |

Tool registry (`src/core/permissions/permissions.ts:36-57`): 20 tools — 7 LEVEL_0, 2 LEVEL_1, 3 LEVEL_2, 5 LEVEL_3, 2 LEVEL_4 (`social.publish`, `n8n.trigger`, no implementation), 1 LEVEL_5 (`infrastructure.modify`, no implementation). `task.create` is registered but granted to no agent. Deployment ceiling `JOVI_MAX_PERMISSION_LEVEL` (default LEVEL_3).

**Models never select tools.** Every tool call is made by first-party agent code; models only return JSON that is Zod-validated.

## 7. Model providers

`anthropic`, `openai`, `gemini` (cloud, opt-in by API key), `lmstudio` (sole local runtime, `http://localhost:1234/v1`), `mock` (simulation only; the registry refuses to mix it with real providers). **No Ollama code path**: only obsolete-variable warnings (`src/core/config/config.ts:103-105`).

## 8. Media providers

| Provider | Kind | Enabled by |
|---|---|---|
| comfyui-image, comfyui-video | LOCAL | `COMFYUI_URL` + workflow file |
| google-flow | CLOUD | never (NOT_INTEGRATED) |
| macos-say | LOCAL | `MACOS_SAY_VOICE` |
| elevenlabs | CLOUD | `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` |
| ffmpeg-render | LOCAL | `JOVI_FFMPEG_PATH` |
| simulated-image/video/voice/render | MOCK | `JOVI_SIMULATION_MODE` only |

## 9. External network calls (all URLs from configuration)

| Call site | Destination | URL source |
|---|---|---|
| `src/models/providers/http.ts:24` (`getJson`/`postJson`) | Anthropic, OpenAI, Gemini, LM Studio, ComfyUI JSON endpoints | `*_BASE_URL`, `LM_STUDIO_URL`, `COMFYUI_URL` |
| `src/integrations/comfyui/comfyui-client.ts:87,101` | ComfyUI `/upload/image`, `/view` | `COMFYUI_URL` |
| `src/media/providers/voice-providers.ts:176,199` | ElevenLabs | `ELEVENLABS_BASE_URL` |

No URL is derived from request bodies, model output, memory or research text (verified by code review and RT-10).

## 10. Filesystem writes

| Site | Path control |
|---|---|
| `src/media/media-store.ts:34,40-41` | `<JOVI_MEDIA_DIR>/<productionId>/<assetId><ext>`; ids regex-validated, extension allow-list |
| `src/database/client.ts:30` | `mkdir` of the SQLite directory (`DATABASE_URL`) |
| `src/database/scripts/reset.ts:18` | deletes the DB files (operator script; refuses in production) |
| External processes | ffmpeg writes `MediaStore.prepare()` paths; `say` writes the `-o` path built the same way |

Reads of arbitrary local files: ComfyUI uploads and ffmpeg inputs are restricted to `MediaStore.isReadableInput`/`holdsFile` (lexical checks; see F-08).

## 11. Process execution

Single call site: `src/media/process-runner.ts:29` — `spawn(binary, args, { shell: false })`. Callers: `FFmpegRenderProvider` (`JOVI_FFMPEG_PATH`), `MacOSSayVoiceProvider` (`MACOS_SAY_PATH`), `MediaInspector` (`JOVI_FFPROBE_PATH`). No `exec`, `execSync`, `eval`, `new Function` or runtime dynamic imports anywhere in `src/` or `apps/`.

## 12. Configuration and secret inputs

54 variables parsed in `src/core/config/config.ts`. Secrets: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `LM_STUDIO_API_KEY`, `ELEVENLABS_API_KEY`, `JOVI_API_TOKEN`. They are loaded from the environment or `.env` (git-ignored; the real environment wins) and masked by `redactConfig` and pino redaction paths. Executable paths: `JOVI_FFMPEG_PATH`, `JOVI_FFPROBE_PATH`, `MACOS_SAY_PATH`.

## 13. Database

SQLite (better-sqlite3, WAL, `foreign_keys=ON`, `busy_timeout=5000`). 18 tables: `jovi_identity`, `identity_versions`, `strategy_versions`, `agents`, `agent_runs`, `models`, `model_runs`, `tasks`, `jobs`, `events`, `decisions`, `evaluations`, `memory_items`, `visual_identity_versions`, `productions`, `production_artifacts`, `media_assets`. Migrations: `0000_phase6_core.sql`, `0001_agent_tool_calls.sql`, `0002_phase8_creative_production.sql`. Raw SQL exists only in `job-queue.ts` and `event-bus.ts`, all with bound parameters.

## 14. Containers, CI and dependencies

- **Docker**: `node:22-bookworm-slim` (tag, not digest), multi-stage, runs as `node`, healthcheck, volume `/app/data`. Compose publishes `127.0.0.1:3000` with `JOVI_ALLOW_UNAUTHENTICATED_NETWORK=true`. No resource limits, no `read_only`, no `cap_drop`. The image contains no ffmpeg or ComfyUI.
- **CI**: none.
- **Dependencies**: 5 runtime dependencies (`better-sqlite3`, `drizzle-orm`, `fastify`, `pino`, `zod`) and 6 dev dependencies; 247 lockfile packages, all from registry.npmjs.org with integrity hashes. Install scripts: `better-sqlite3` (downloads a prebuilt native binary), `esbuild` ×3 (dev), `fsevents` (optional). The SBOM is in `docs/audit/sbom-runtime.cdx.json` (CycloneDX 1.5, 87 runtime components).

## 15. Prompts, memory and events

- **Prompts**: 11 files under `prompts/` (system, executive, evaluation, production ×5, json-repair, agents README). Identity facts are rendered from the active identity version; prompts contain no secrets.
- **Memory systems**:
  - operational (`memory_items`, trust by source)
  - knowledge (Markdown under `knowledge/jovi`)
  - semantic: `KeywordSemanticMemory` (`src/memory/semantic/semantic-memory.ts:33`) — **not vector-backed; no embeddings exist**
- **Events**: 74 event types (`src/types/enums.ts`), persisted with correlation/causation ids. No API route writes events.
