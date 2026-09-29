# Jovi Creator OS — Jovi Core v0.1

Jovi is an autonomous AI virtual creator. Jovi Creator OS will eventually run the full creator loop:

```
Research → Strategy → Ideation → Creation → QA → Publishing → Analytics → Learning → Evolution
```

**Phase 6 (this release) implements only the core brain:**

```
GOAL → TASK → JOB → CONTEXT → EXECUTIVE AGENT → MODEL ROUTER → MODEL (LM Studio or cloud)
     → STRUCTURED OUTPUT (Zod) → EVALUATION → DECISION → MEMORY → EVENTS → RESULT (API / CLI)
```

It does **not** generate images or video, publish, ingest analytics or discover opportunities. Those are later phases. Phase 6 is a *controlled brain*: it proposes and decides, and never acts outside the system.

Architecture details: [`docs/phase-6-architecture.md`](docs/phase-6-architecture.md).

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
```

Start the API:

```bash
npm run start:dev             # tsx, http://127.0.0.1:3000
# or
npm run build && npm start    # compiled
```

```bash
curl -s -X POST http://127.0.0.1:3000/api/jovi/goal \
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
```

The CLI calls the same `JoviOrchestrator.executeGoal()` as the API.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness, DB, provider availability, `lmStudio` discovery, `simulationMode` |
| GET | `/api/jovi/identity` | Active identity + version history |
| GET | `/api/jovi/strategy` | Active strategy version |
| POST | `/api/jovi/goal` | Execute a goal (`{"goal", "tier"?, "privacy"?: "LOCAL_ONLY", "mode"?: "sync" \| "async"}`) — rate limited |
| GET | `/api/jovi/goal/:taskId` | Poll a goal result (async mode) |
| GET | `/api/tasks/:id` | Task + its jobs |
| GET | `/api/jobs/:id` | Job |
| GET | `/api/decisions/:id` | Decision (options, selection, evaluation, models used) |
| GET | `/api/events` | Events (`type`, `correlationId`, `entityId`, `afterSequence`, `limit`) |
| POST | `/api/memory` | Add untrusted external memory (restricted types; see Security) |
| GET | `/api/memory` | List (`type`, `key`, `includeExpired`) or search (`q`) memory |
| GET | `/api/models` | Provider status, models table, competition availability, routing policy |
| GET | `/api/agents` | Active and planned agents, permission levels |
| POST | `/api/evaluate` | Evaluate ad-hoc options (`{objective, options}`) or a decision (`{decisionId}`) — rate limited |

`POST /api/jovi/goal` returns `taskId`, `jobId`, `decisionId`, `selectedAction`, `options`, `confidence`, `reasoningSummary`, `nextActions`, `modelsUsed` (with `executionType`), `eventsGenerated`, `simulated` (plus `correlationId`, `selection`, `interpretation`, `priorities`, `contentDirection`, `evaluationSummary`, `attempts`). Status codes: `200` completed, `202` queued (async), `400` invalid input, `409` conflict, `429` rate limited (`Retry-After`), `503` no model available, `500` other failure.

---

## Security

- **Bind guard:** the API refuses to start on a non-loopback `HOST` unless `JOVI_API_TOKEN` is set (`Authorization: Bearer <token>`). Expensive endpoints are rate limited per client (`JOVI_GOAL_RATE_LIMIT_PER_MINUTE`) and capped in concurrency (`JOVI_MAX_CONCURRENT_GOALS`).
- **Enforced permissions:** agents receive no services — only a per-run **ToolKit** whose every method checks the agent's allow-list and level (capped at `JOVI_MAX_PERMISSION_LEVEL`). Every call, allowed or denied, is stored in `agent_runs.tool_calls`. There are no shell, filesystem, credential, publishing or infrastructure tools. Executive = `LEVEL_2_MODIFY`.
- **Next actions:** required level = max(text classification, owning agent's level). External (`LEVEL_4+`) or unknown-owner actions are `REQUIRES_APPROVAL`.
- **Memory poisoning:** `POST /api/memory` accepts only FACT/PREFERENCE/LEARNING/AUDIENCE/CONTENT/EXPERIMENT/TEMPORARY, forces `source=api`, caps importance/confidence, limits size, and cannot overwrite seed/agent memory (409). Retrieved memory is rendered inside `<memory_data>` with a trust label, angle brackets escaped, and the model is told it is data, not instructions.
- **Identity:** prompt files contain no identity facts; they are rendered from the *active* identity version.
- **Secrets** come only from the environment / `.env` (git-ignored, real env wins); logs show keys as `configured`/`missing`. Model output is parsed as Zod-validated data, never executed.
- **Jobs** keep a heartbeat; abandoned jobs (crashed process) are recovered at startup and periodically by the worker.

## What's inside

- **Executive Agent** (`src/agents/executive`) — interprets the goal, generates 2–5 options, has them evaluated, selects one, delegates next actions, persists decision + memory.
- **Agent contract + runner + ToolKit** (`src/agents`) — validate input → load context → execute → validate output → persist → emit → return. Ten further agents are registered as *planned*.
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
```

## Docker

```bash
docker compose up --build   # API on 127.0.0.1:3000, data in ./data
```

LM Studio runs on the host; the container reaches it at `host.docker.internal:1234` (override with `LM_STUDIO_URL_DOCKER`).

## Observability & cost

- Structured JSON logs (pino) carry `taskId`, `jobId`, `correlationId`, `agent`, `provider`, `model`, `durationMs`, retries and errors. Everything is queryable in SQLite (`tasks`, `jobs`, `agent_runs`, `model_runs`, `events`, `decisions`).
- Cost: cloud runs record list-price estimates (or `null` when unknown); LM Studio records `0` with `LOCAL_COMPUTE`; simulation records `0` with `NONE`.

## Known limitations (Phase 6)

- No real-model run has been verified yet in CI (see `npm run test:lmstudio:real`).
- One model per provider is routed (a second loaded LM Studio model is not yet used as an independent evaluator).
- Semantic memory is a lexical baseline; model competition is availability-only; goal tiering is a keyword heuristic; pricing figures are estimates.
- No dashboard, publishing, image/video generation, analytics ingestion or n8n integration yet.
