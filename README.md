# Jovi Creator OS — Jovi Core v0.1

Jovi is an autonomous AI virtual creator. Jovi Creator OS will eventually run the full creator loop:

```
Research → Strategy → Ideation → Creation → QA → Publishing → Analytics → Learning → Evolution
```

**Phase 9 (this release) adds real media generation** — the `Image/Video/Voice → Editing` segment of the Phase 8 creative production boundary — on top of Phase 8 creative production, Phase 7 planning and the Phase 6 core brain:

```
Phase 7 idea → Script → Storyboard → Visual prompts → {Image ∥ Video ∥ Voice} → Edit plan → Render → QA → HUMAN APPROVAL BOUNDARY
                                                     └──────── Phase 9: capability-routed real providers, verified outputs ────────┘
```

The Phase 6 core brain (still the foundation):

```
GOAL → TASK → JOB → CONTEXT → EXECUTIVE AGENT → MODEL ROUTER → MODEL (LM Studio or cloud)
     → STRUCTURED OUTPUT (Zod) → EVALUATION → DECISION → MEMORY → EVENTS → RESULT (API / CLI)
```

Media is generated **only through a configured, available provider**: ComfyUI (image/video), macOS `say` or ElevenLabs (voice), ffmpeg (render). Every provider is opt-in; an unconfigured kind yields `BLOCKED` assets, never fakes. Google Flow has no executable API and stays `NOT_INTEGRATED`. Nothing is published: the furthest a production goes is `AWAITING_HUMAN_APPROVAL`, and approval itself does not publish. Publishing, analytics and learning are later phases.

Architecture: [`docs/phase-6-architecture.md`](docs/phase-6-architecture.md) · [`docs/phase-7-architecture.md`](docs/phase-7-architecture.md) · [`docs/phase-8-architecture.md`](docs/phase-8-architecture.md) · [`docs/phase-9-architecture.md`](docs/phase-9-architecture.md) · NotebookLM notes: [`docs/phase-8-notebooklm-project-note.md`](docs/phase-8-notebooklm-project-note.md), [`docs/phase-9-notebooklm-project-note.md`](docs/phase-9-notebooklm-project-note.md).

---

## Quick start

Requirements: Node.js ≥ 22.12, npm.

```bash
npm install
cp .env.example .env          # add LM Studio / cloud settings (loaded automatically)
npm run db:seed               # creates data/jovi.db, runs migrations, loads Jovi's identity/strategy/memory
npm run jovi:providers        # shows what is available (LM Studio discovery included)
```

Run a goal (needs LM Studio with a loaded model, or a cloud API key):

```bash
npm run jovi -- "Create an Instagram Reel concept that introduces Jovi to a new audience and makes viewers curious about who she is."
npm run jovi -- --local-only "<goal>"     # force LM Studio for generation AND evaluation
npm run jovi:plan -- "<goal>"              # Research → Trends → Strategy → Ideation
npm run jovi -- --produce "<goal>"         # plan, then produce the recommended idea (stops at human approval)
```

Start the API:

```bash
npm run start:dev             # tsx, http://127.0.0.1:3000
# or
npm run build && npm start    # compiled
```

On first start the API creates an `owner` credential (all scopes) and prints its token **once** to stderr; only its SHA-256 hash is stored. Create narrower credentials with `npm run jovi -- --api-token create --name n8n --scopes read,operate`.

```bash
curl -s -X POST http://127.0.0.1:3000/api/jovi/goal \
  -H "authorization: Bearer $JOVI_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"goal":"Create an Instagram Reel concept introducing Jovi to a new audience.","privacy":"LOCAL_ONLY"}'
```

No model yet? `npm run jovi -- --simulate "<goal>"` exercises the pipeline with a deterministic mock. It is **simulation only**: canned output, flagged `simulated: true`, never combined with or used as a fallback for real providers.

---

## Model providers

Only **one** provider is required. Unconfigured providers report `unavailable`; they never crash the app.

| Provider | Kind | Configure | Notes |
|---|---|---|---|
| **LM Studio** | LOCAL (only local runtime) | `LM_STUDIO_URL` (default `http://localhost:1234/v1`), optional `LM_STUDIO_MODEL`, `LM_STUDIO_API_KEY`, `LM_STUDIO_TIMEOUT_MS` (default 600000) | OpenAI-compatible local server. `estimatedApiCost = 0`, `executionCostType = LOCAL_COMPUTE`. Never downloads or loads models. |
| Anthropic | CLOUD | `ANTHROPIC_API_KEY`, optional `ANTHROPIC_MODEL` | |
| OpenAI | CLOUD | `OPENAI_API_KEY`, optional `OPENAI_MODEL` | |
| Gemini | CLOUD | `GEMINI_API_KEY`, optional `GEMINI_MODEL` | |
| Mock | MOCK | `JOVI_SIMULATION_MODE=true` or CLI `--simulate` | **Simulation/test only.** Registered alone; the registry refuses to mix it with real providers. |

### LM Studio setup

1. In LM Studio, download a chat model (any instruct model; 7B+ recommended for reliable JSON).
2. **Load** it (model picker, or `lms load <model-id>`).
3. Start the local server: *Developer → Start Server*, or `lms server start` (default port 1234).
4. Optionally pin the model: `LM_STUDIO_MODEL=<model-id>` in `.env` (ids from `lms ls` or `curl http://localhost:1234/v1/models`).
5. Check: `npm run jovi:providers` should show `lmstudio ● LOCAL <model>` with `reachable: true`, `loaded: true`.

Discovery uses LM Studio's native REST API (`/api/v1/models` on LM Studio ≥ 0.4, else `/api/v0/models`) to see which models are actually **loaded**, falling back to the OpenAI-compatible `/v1/models` (load state then reported as `unknown`). LM Studio is reported **unavailable** — with the exact remedy — when the server is not running, no chat model exists, `LM_STUDIO_MODEL` is missing, or no model is loaded. Reasoning-model `<think>` blocks are stripped and never stored.

Small local models may return invalid JSON. The router asks once for a repair, then falls back to the next candidate; the job retries temporary failures.

### Routing policy

| Tier | Policy |
|---|---|
| LOW (local tasks) | LM Studio; cloud fallback only if `JOVI_ALLOW_CLOUD_FALLBACK=true` (default) |
| NORMAL | Configured cloud (`JOVI_CLOUD_PREFERENCE`); LM Studio fallback |
| HIGH | Cloud; LM Studio only as a flagged *degraded* fallback |
| STRATEGIC | Cloud, plus an independent evaluator model when available |
| privacy `LOCAL_ONLY` | LM Studio only (generation and evaluation) |

Timeouts are per provider (cloud `JOVI_PROVIDER_TIMEOUT_MS`, LM Studio `LM_STUDIO_TIMEOUT_MS`). Every attempt is recorded in `model_runs` (provider, model, category, reason, fallback, latency, tokens, estimated cost, success/failure) and surfaced as `MODEL_SELECTED` / `MODEL_FALLBACK` events.

---

## CLI

```bash
npm run jovi -- "<goal>"                  # execute a goal
npm run jovi -- --local-only "<goal>"     # LM Studio only
npm run jovi -- --tier STRATEGIC "<goal>" # override routing tier
npm run jovi -- --json "<goal>"           # raw JSON result
npm run jovi -- --providers               # provider status + LM Studio discovery
npm run jovi -- --identity                # Jovi's active identity
npm run jovi -- --simulate "<goal>"       # simulation only (mock)
npm run jovi -- --plan "<goal>"           # Phase 7 planning
npm run jovi -- --produce "<goal>"        # Phase 7 planning → Phase 8 production of the recommended idea
npm run jovi -- --produce --from-plan <planningTaskId> [--idea idea-2] [--aspect-ratio 9:16]
npm run jovi -- --production <productionId>                 # status, assets, QA, publishing gate
npm run jovi -- --decide <productionId> --decision APPROVE [--acknowledge-warnings] [--note "<text>"] [--yes]
                                                            # HUMAN: reviewer = your OS account (local:<user>); retype the id to confirm
npm run jovi -- --simulate --produce "<goal>"               # simulation: canned text + SIMULATED media
npm run jovi -- --regenerate-media <productionId> [--kinds IMAGE,VOICE] [--include-completed] [--yes]
                                                            # HUMAN: redo media (text reused), re-edit, re-QA
npm run jovi -- --visual-identity                           # active visual identity + versions
npm run jovi -- --set-visual-identity profile.json --summary "<why>" [--yes]   # HUMAN: lock appearance (retype "identity")
npm run jovi -- --api-token create --name <name> --scopes read,operate[,approve,identity-admin]   # token shown once
npm run jovi -- --api-token list | --api-token revoke --name <name>
npm run jovi -- --api-token create --name ci --scopes read --expires-days 30   # optional expiry
npm run jovi -- --api-token rotate --name n8n [--grace-days 7]                 # new token; old one valid for the grace period
npm run jovi -- --audit-verify                              # verify the event hash chain; prints the head hash
npm run jovi -- --retention [--dry-run]                     # apply data retention (runs; events only if enabled)
npm run jovi -- --backup ~/Backups/jovi.db                  # online SQLite backup (0600, never overwrites)
npm run jovi -- --media-gc [--dry-run] [--older-than-days 7] # delete files of SUPERSEDED media (records kept)
```

Actor fields (`reviewer`, `requestedBy`, `approvedBy`) are never typed in: the CLI uses the local OS account and the API uses the credential principal (`api:<name>`). Interactive confirmations need a TTY; scripts must pass `--yes`.

The CLI calls the same `JoviOrchestrator.executeGoal()` as the API.

## API

Every route except `/health` requires `Authorization: Bearer <token>` with the right **scope**: `read` (GET), `operate` (goals, planning, productions, regeneration, memory, evaluation), `approve` (`/decision`), `identity-admin` (`POST /api/visual-identity`). Requests whose `Host` or `Origin` is not allow-listed get `403` (DNS-rebinding defence).

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | **Public** minimal liveness: `{status, service, database}` |
| GET | `/api/status` | Detailed status: DB, provider availability, `lmStudio` discovery, `simulationMode` |
| GET | `/api/auth/whoami` | The calling principal and its scopes |
| GET | `/api/jovi/identity` | Active identity + version history |
| GET | `/api/jovi/strategy` | Active strategy version |
| POST | `/api/jovi/goal` | Execute a goal (`{"goal", "tier"?, "privacy"?: "LOCAL_ONLY", "mode"?: "sync" \| "async"}`) — rate limited |
| GET | `/api/jovi/goal/:taskId` | Poll a goal result (async mode) |
| GET | `/api/tasks/:id` | Task + its jobs |
| GET | `/api/jobs/:id` | Job |
| GET | `/api/decisions/:id` | Decision (options, selection, evaluation, models used) |
| GET | `/api/audit/verify` | (`approve` scope) Verify the event hash chain; returns its head `{sequence, hash}` |
| GET | `/api/events` | Events (`type`, `correlationId`, `entityId`, `afterSequence`, `limit`) |
| POST | `/api/memory` | Add untrusted external memory (restricted types; see Security) |
| GET | `/api/memory` | List (`type`, `key`, `includeExpired`) or search (`q`) memory |
| GET | `/api/models` | Provider status, models table, competition availability, routing policy |
| GET | `/api/agents` | Active and planned agents, permission levels |
| POST | `/api/evaluate` | Evaluate ad-hoc options (`{objective, options}`) or a decision (`{decisionId}`) — rate limited |
| POST | `/api/jovi/planning` | Phase 7 planning (Research → Trends → Strategy → Ideation) |
| POST | `/api/productions` | Phase 8 production: exactly one of `{"goal"}`, `{"planningTaskId", "ideaId"?}` or `{"idea"}`; `aspectRatio`?, `privacy`?, `mode`? — rate limited |
| GET | `/api/productions/:id` | Production status, source idea, assets, QA summary, publishing gate, events |
| GET | `/api/productions/:id/{script,storyboard,visual-prompts,edit-plan,qa}` | Latest artifact of that kind |
| GET | `/api/productions/:id/assets` | Media asset records (status, provider, location, reason) |
| GET | `/api/productions/:id/publishing-gate` | `eligibleForHumanPublishing`, blockers; `autonomousPublishingAllowed` is always `false` |
| POST | `/api/productions/:id/decision` | HUMAN decision (`approve` scope) `{"decision": "APPROVE"\|"REJECT", "note"?, "acknowledgeWarnings"?}`; the reviewer is the credential principal (a body `reviewer` is rejected) — `409` if QA does not allow it |
| GET | `/api/media/providers` | Media provider states (AVAILABLE / NOT_CONFIGURED / UNREACHABLE / MISCONFIGURED / NOT_INTEGRATED), capabilities and preference order |
| POST | `/api/productions/:id/regenerate-media` | HUMAN request `{"reason"?, "kinds"?: ["IMAGE"\|"VIDEO"\|"VOICE"], "includeCompleted"?, "mode"?}` for a BLOCKED / AWAITING_HUMAN_APPROVAL production — `409` otherwise; rate limited |
| GET | `/api/visual-identity` | Active visual identity + versions |
| POST | `/api/visual-identity` | HUMAN (`identity-admin` scope): new version `{"profile", "changeSummary"}`, approver = credential principal; LOCKED when every appearance anchor is set; reference images must be files in `JOVI_REFERENCE_DIR` |

`POST /api/jovi/goal` returns `taskId`, `jobId`, `decisionId`, `selectedAction`, `options`, `confidence`, `reasoningSummary`, `nextActions`, `modelsUsed` (with `executionType`), `eventsGenerated`, `simulated` (plus `correlationId`, `selection`, `interpretation`, `priorities`, `contentDirection`, `evaluationSummary`, `attempts`). Status codes: `200` completed, `202` queued (async), `400` invalid input, `401` missing/invalid credential, `403` wrong scope or foreign Host/Origin, `409` conflict, `429` rate limited (`Retry-After`), `503` no model available, `500` other failure.

---

## Security

- **Authentication is mandatory** (security remediation R-01/R-04, see `docs/audit/14-p0-remediation-status.md`). Credentials are 256-bit `jovi_…` tokens stored as SHA-256 hashes in `api_credentials`, each with scopes `read` / `operate` / `approve` / `identity-admin`, revocable by name (names are never reused). An optional `JOVI_API_TOKEN` (≥ 32 characters) is an operator token with `JOVI_API_TOKEN_SCOPES` (default `read,operate`). Who approved, regenerated or changed visual identity is always the authenticated principal.
- **Host/Origin allow-list:** `localhost`, `127.0.0.1`, `::1`, the bind host and `JOVI_ALLOWED_HOSTS`; browser `Origin`s must use one of those hosts or be listed in `JOVI_ALLOWED_ORIGINS`. Responses carry `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a deny-all CSP and `Cache-Control: no-store`.
- **Bind guard:** a non-loopback `HOST` requires `JOVI_ALLOW_NETWORK_BIND=true` and logs a plain-HTTP warning (put TLS in front). Expensive endpoints are rate limited per client (`JOVI_GOAL_RATE_LIMIT_PER_MINUTE`) and capped in concurrency (`JOVI_MAX_CONCURRENT_GOALS`).
- **Resource limits** (R-05):
  - Async jobs keep holding their concurrency slot until they finish, so `"mode": "async"` cannot bypass `JOVI_MAX_CONCURRENT_GOALS`.
  - The job queue is capped (`JOVI_MAX_QUEUED_JOBS`).
  - Memory, decision and visual-identity writes are rate limited per principal (`JOVI_WRITE_RATE_LIMIT_PER_MINUTE`), and external memory has a total cap.
  - Fastify's `requestTimeout` stops slow clients.
  - Regenerations are capped per production.
  - The media directory has a quota (`JOVI_MEDIA_QUOTA_MB`), and the worker deletes the files of `SUPERSEDED` assets after `JOVI_SUPERSEDED_RETENTION_DAYS`. Asset records are kept.
  - A daily estimated cloud budget (`JOVI_DAILY_CLOUD_BUDGET_USD`) excludes cloud models and cloud media providers once spent.
- **Context selection** (R-06): memory below a relevance floor is never included. Trusted (seed) memory gets reserved slots (6 of 10), and untrusted API memory is capped at 2 items per context.
- **Audit integrity** (R-08):
  - Every event row is hash-chained (`hash = sha256(prev_hash ‖ row)`); `npm run jovi -- --audit-verify` checks the chain and prints its head. Record the head outside the machine.
  - Approval, rejection, visual-identity and credential events are *protected*: only the owning service, holding a capability issued once at bootstrap, can emit them.
  - The publishing gate reports "approval not attested" unless an `APPROVED` status matches a chain-valid `PRODUCTION_APPROVED` event with the same reviewer.
  - 401/403 refusals are stored as `API_AUTH_FAILED` events, throttled per client.
  - Every external process execution is logged: binary, arguments with paths redacted, duration and exit code.
- **Hardening** (P2, R-09 … R-18):
  - **R-09:** media and reference confinement is checked on real paths, refuses symlinks, and reads with `O_NOFOLLOW`.
  - **R-11:** human-entered visual-identity anchors are checked for real-person likeness, minors and explicit content, and `apparentAge` must match the identity.
  - **R-12:** 5xx responses are generic and carry a `requestId`.
  - **R-13:** operator tokens must pass an entropy check. `JOVI_API_TOKEN_PREVIOUS` allows a rollover, and stored credentials support expiry and `rotate`.
  - **R-15:** provider responses are streamed with byte caps (JSON 10 MB, image 20 MB, audio 50 MB, video 200 MB).
  - **R-16:** destructive and filesystem phrasings in proposed actions classify as LEVEL_5.
  - **R-17:** optional SHA-256 pins for executables and ComfyUI workflows; a warning when LM Studio or ComfyUI is not on loopback. See `docs/security/trust-model.md`.
  - **R-18:** owner-only database permissions, retention, and backups. See `docs/security/data-at-rest.md`.
- **Supply chain** (R-07): `.github/workflows/ci.yml` runs typecheck, tests, build, `npm audit`, osv-scanner, a gitleaks scan of the full history and an SBOM artifact. It uses a read-only token, SHA-pinned actions and checksum-verified scanners. Dependabot covers npm, actions and the Docker base image, which is pinned by digest. Branch protection is an owner step: see `docs/security/sdlc-runbook.md`.
- **Pre-generation safety gate** (R-02): after the visual prompts and before **any** media request, the `safety-review` agent runs the identity/safety heuristics and an independent model review against a fixed rubric (adult only, AI transparency, identity consistency, no real-person likeness, platform safety). Anything but a full ALLOW — including a model error or invalid output — is `BLOCK` (fail-closed) and the production stops `BLOCKED`. `MediaService` independently refuses to call a provider without a current ALLOW review (`SAFETY_REVIEW_REQUIRED` / `_BLOCKED` / `_STALE`). Pattern checks are labelled `HEURISTIC` in QA: they are not proof of compliance.
- **Enforced permissions:** agents receive no services — only a per-run **ToolKit** whose every method checks the agent's allow-list and level (capped at `JOVI_MAX_PERMISSION_LEVEL`). Every call, allowed or denied, is stored in `agent_runs.tool_calls`. There are no shell, filesystem, credential, publishing or infrastructure tools. Executive = `LEVEL_2_MODIFY`. Artifact writes are scoped per kind (`production.write:SCRIPT`, …, `production.write:QA_REPORT`), so only the QA agent can record a QA verdict (R-10).
- **External processes (not agent tools):**
  - The media layer runs operator-configured executables: ffmpeg (render), ffprobe (inspection) and macOS `say` (voice).
  - They are run with `shell: false`, arguments built by code from validated paths, free text sent via stdin or an SRT file, timeouts, and a log entry per execution.
  - The binary path comes from `.env`, so `.env` write access means code execution as the Jovi user.
  - Optional SHA-256 pins (`JOVI_FFMPEG_SHA256`, `JOVI_FFPROBE_SHA256`, `MACOS_SAY_SHA256`) refuse a replaced binary. See `docs/security/trust-model.md`.
- **Next actions:** required level = max(text classification, owning agent's level). External (`LEVEL_4+`) or unknown-owner actions are `REQUIRES_APPROVAL`.
- **Memory poisoning:** `POST /api/memory` accepts only FACT/PREFERENCE/LEARNING/AUDIENCE/CONTENT/EXPERIMENT/TEMPORARY, forces `source=api`, caps importance/confidence, limits size, and cannot overwrite seed/agent memory (409). Retrieved memory carries provenance (R-03): `trusted` (seed only), `derived` (agent-written from goals and model output) or `untrusted` (API). Memory, knowledge, recent decisions and similar past concepts are rendered only inside escaped `<memory_data>` / `<knowledge_data>` / `<history_data>` blocks with those labels, and the model is told they are data, not instructions. Decision memory stores a SHA-256 of the objective, never the raw goal text.
- **Identity:** prompt files contain no identity facts; they are rendered from the *active* identity version.
- **Secrets** come only from the environment / `.env` (git-ignored, real env wins); logs show keys as `configured`/`missing`. Model output is parsed as Zod-validated data, never executed.
- **Jobs** keep a heartbeat; abandoned jobs (crashed process) are recovered at startup and periodically by the worker.

## What's inside

- **Executive Agent** (`src/agents/executive`) — interprets the goal, generates 2–5 options, has them evaluated, selects one, delegates next actions, persists decision + memory.
- **Agent contract + runner + ToolKit** (`src/agents`) — validate input → load context → execute → validate output → persist → emit → return. Three further agents (publishing, analytics, learning) are registered as *planned*; they have no implementation and no tools.
- **Context Engine** — bounded assembly of identity, strategy, relevant memory (trust-labelled), knowledge excerpts, recent decisions, similar past concepts and constraints.
- **Evaluator** — independent second model (labeled 1–5 judgements) plus deterministic rule checks on *content* fields (AI transparency, privacy, platform safety, clichés, pillar alignment, personality); negated/safeguard phrasing is not a violation.
- **Memory** — operational (SQLite), knowledge (`knowledge/jovi/*.md`), semantic (interface + lexical baseline).
- **Events**, **tasks & jobs** (SQLite-backed, retries, heartbeat, crash recovery), **permissions**, **prompts** outside TypeScript.

## Project layout

```
apps/        api (Fastify, security) · orchestrator (CLI, worker) · dashboard (planned)
src/         agents · core · models · memory · integrations (lmstudio) · database · types
prompts/     system · executive · evaluation · agents
knowledge/   jovi/ character-bible · voice-guide · visual-bible · content-strategy · privacy-boundaries
tests/       unit · integration · fakes (fake LM Studio HTTP server)
docs/        architecture notes
docker/      Dockerfile
data/        local SQLite (git-ignored)
```

## Database

SQLite via Drizzle. Migrations run automatically on startup.

```bash
npm run db:migrate      # apply migrations
npm run db:seed         # idempotent seed (never overwrites evolved data)
npm run db:reset        # delete + recreate local DB (refuses in production)
npm run db:generate     # regenerate migrations after editing src/database/schema.ts
```

## Testing

```bash
npm run typecheck
npm test                    # no network, no API keys, no LM Studio required
npm run build
npm run test:lmstudio       # LM Studio adapter + flow suites (fake LM Studio server)
npm run test:lmstudio:real  # REAL LM Studio end to end (needs the server running with a model loaded)
npm run test:production     # Phase 8–9 + safety gate: contracts, media providers (fake servers/binaries), generation, regeneration, pipeline e2e
npm run test:production:real  # REAL LM Studio run of the Phase 8 text agents (script/storyboard/prompts/QA)
JOVI_MEDIA_REAL=1 npx vitest run tests/integration/media.real.test.ts   # REAL media providers that are configured
```

Test categories are kept distinct: **deterministic unit** (schemas, QA engine, state machines, capability matching, inspector, render command, governance), **fake-server / fake-binary integration** (ComfyUI and ElevenLabs HTTP stand-ins, stand-in `say`/`ffmpeg` scripts), **simulated / test-double pipeline** (canned text; LOCAL/CLOUD test-double media providers writing real-signature files — *not* external integrations) and **real-provider E2E** (opt-in `*.real.test.ts`; each provider block runs only when configured and is otherwise reported as skipped).

## Docker

```bash
docker compose up --build   # API on 127.0.0.1:3000, data in ./data
```

LM Studio runs on the host; the container reaches it at `host.docker.internal:1234` (override with `LM_STUDIO_URL_DOCKER`).

- **Hardening (R-14).** The container runs as the `node` user with:
  - a read-only root filesystem: only `./data` and a 64 MB `/tmp` are writable;
  - all Linux capabilities dropped, and `no-new-privileges`;
  - 2 GB memory, 2 CPU and 256 PID limits.

  The CI job "Container (hardened compose)" builds the image and checks these settings on a running container.
- **`./data` permissions.** `./data` must be writable by uid 1000 (`sudo chown 1000:1000 data` on Linux; Docker Desktop handles this on macOS).
- **The owner token** is printed once in `docker compose logs jovi-core` on first start.
- **No ffmpeg, ffprobe or `say` in the image (D-18).** In the container the render and macOS voice providers report `NOT_CONFIGURED`, so productions stop `BLOCKED` at the render step. For real renders run Jovi on the host, or build a derived image with ffmpeg and pin it (`JOVI_FFMPEG_PATH` + `JOVI_FFMPEG_SHA256`).

## Observability & cost

- Structured JSON logs (pino) carry `taskId`, `jobId`, `correlationId`, `agent`, `provider`, `model`, `durationMs`, retries and errors. Everything is queryable in SQLite (`tasks`, `jobs`, `agent_runs`, `model_runs`, `events`, `decisions`).
- Cost: cloud runs record list-price estimates (or `null` when unknown); LM Studio records `0` with `LOCAL_COMPUTE`; simulation records `0` with `NONE`.

## Phase 7 planning

The planning layer is exposed through `npm run jovi:plan -- "<goal>"` and `POST /api/jovi/planning`. It runs four structured agents — Research, Trends, Strategy and Ideation — through the same permission-enforced AgentRunner and Model Router. Research is explicitly not live-web verification until a web research connector is added. Strategy output is a proposal only and does not mutate the active strategy.

## Phase 8 creative production

`npm run jovi -- --produce "<goal>"` / `POST /api/productions` runs Phase 7 planning (or reuses a planning task via `planningTaskId`) and produces the recommended idea (`recommendedIdeaIds[0]`, or `ideaId`):

- **Eight agents**, all through the same AgentRunner, ToolKit permissions, TaskService/JobQueue and Model Router: Script, Storyboard, Visual Prompt (text, `LEVEL_2`), Image Generation, Video Generation, Voice, Editing (`LEVEL_3`, one media tool each) and QA (`LEVEL_2`). None can publish, approve or change identity.
- **Providers are abstractions** (`src/media/types.ts`): image (ComfyUI), video (ComfyUI, Google Flow slot), voice, editing/render. A kind without an available provider yields `BLOCKED` assets with the reason. `MediaService` marks an asset `COMPLETED` only when a non-mock provider returned output that exists as a non-empty file inside `JOVI_MEDIA_DIR` (or an https URL).
- **Asset lifecycle:** `REQUESTED → QUEUED → GENERATING → COMPLETED | SIMULATED | FAILED`, `BLOCKED` when no provider, `REJECTED` by a human.
- **QA** combines deterministic identity/safety/technical checks with model-judged quality checks → `PASS | PASS_WITH_WARNINGS | FAIL | BLOCKED`. Anything that cannot be verified (e.g. face consistency with no visual inspector, an unlocked visual identity, simulated/blocked media) is `NOT_VERIFIABLE`, never `PASSED`.
- **Human boundary:** productions end at `AWAITING_HUMAN_APPROVAL` (QA passed) or `BLOCKED`. Only `recordHumanDecision` (CLI `--decide`, API `/decision`) can set `APPROVED`/`REJECTED`; `PASS_WITH_WARNINGS` needs `acknowledgeWarnings`. There is no publish state, tool or endpoint.
- **Visual identity:** Jovi's appearance anchors (face, hair, eyes, beauty mark…) are not locked yet (see `knowledge/jovi/visual-bible.md`), so identity QA is `BLOCKED` until a human records a locked `visual_identity_versions` row. Agents can read it but never write it.

ComfyUI setup: set `COMFYUI_URL`, export your workflow with *Save (API)*, replace the prompt/size/seed/prefix inputs with the placeholders listed in `.env.example`, and point `COMFYUI_IMAGE_WORKFLOW` / `COMFYUI_VIDEO_WORKFLOW` at the files. Check with `npm run jovi:providers`.

## Phase 9 real media generation

- **One provider contract** for simulated, test-double and real providers: `capabilities()` (aspect ratios, max duration, image-to-video, reference images, languages, formats) + `inspectAvailability()` + the generate method.
- **Capability routing** (`MediaProviderRegistry.candidates`): hard requirements (aspect ratio, duration, language, privacy — `LOCAL_ONLY` excludes cloud) filter providers; `JOVI_MEDIA_PROVIDER_PREFERENCE`, soft preferences (reference images, image-to-video), LOCAL-before-CLOUD order the rest. Later candidates are **fallbacks** (`MEDIA_PROVIDER_FALLBACK` event).
- **Verified outputs** (`MediaInspector`): a file is accepted only if its container signature matches the asset kind; duration/dimensions are measured (ffprobe when `JOVI_FFPROBE_PATH` is set, else headers) and replace provider claims; a SHA-256 is recorded.
- **Real adapters**: ComfyUI (+ reference-image and image-to-video uploads), macOS `say`, ElevenLabs, ffmpeg render (h264/aac MP4 with soft subtitles; missing scenes render black and are listed as placeholders that block the publishing gate).
- **Human-requested media regeneration** for BLOCKED / AWAITING_HUMAN_APPROVAL productions: text stages are reused, unusable (or chosen) assets become `SUPERSEDED`, edit plan and QA are redone, and the production again stops at the approval boundary.
- **Visual identity locking** via API/CLI (human only), with reference images confined to `JOVI_REFERENCE_DIR`.

Setup on a Mac: `brew install ffmpeg` → `JOVI_FFMPEG_PATH=/opt/homebrew/bin/ffmpeg`, `JOVI_FFPROBE_PATH=/opt/homebrew/bin/ffprobe`; choose a voice with `say -v '?'` → `MACOS_SAY_VOICE=<name>`; start ComfyUI and set `COMFYUI_URL` + workflow paths. Check with `npm run jovi:providers`.

## Known limitations (Phase 9)

- Real-provider validation so far: **ffmpeg render only**, in the Linux build container (ffmpeg 6.1.1) with ffmpeg-synthesised test-pattern inputs. ComfyUI, macOS `say` and ElevenLabs have fake-server/fake-binary coverage only. Google Flow is not integrated.
- No automated visual-identity inspector: face/hair/eyes consistency remains a human review item; Jovi's appearance anchors are not locked until a human records them.
- Text overlays are not burned into renders (captions are a soft subtitle track); music is not selected.
- The Phase 8 text agents were validated against real LM Studio (`google/gemma-4-12b-qat`, 2/2) on the owner's machine; that run was not clean (one schema-length failure, one ~5-minute header timeout).
- No real-model run is part of CI (see `npm run test:lmstudio:real`).
- The pre-generation safety review (R-02) has been exercised only with test-double models; its effectiveness with a real local model is not yet measured. Its heuristics are pattern checks, not proof of compliance.
- One model per provider is routed (a second loaded LM Studio model is not yet used as an independent evaluator).
- Semantic memory is a lexical baseline; model competition is availability-only; goal tiering is a keyword heuristic; pricing figures are estimates.
- No dashboard, publishing, analytics ingestion or n8n integration yet.
