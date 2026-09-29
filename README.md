# Jovi Creator OS — Jovi Core v0.1

Jovi is an autonomous AI virtual creator. Jovi Creator OS will eventually run the full creator loop:

```
Research → Strategy → Ideation → Creation → QA → Publishing → Analytics → Learning → Evolution
```

**Phase 6 (this release) implements only the core brain:**

```
GOAL → EXECUTIVE AGENT → CONTEXT → MODEL ROUTER → MODEL → STRUCTURED DECISION
     → PERSIST DECISION → PERSIST MEMORY → EMIT EVENTS → RETURN RESULT
```

It does **not** generate images or video, publish, ingest analytics or discover opportunities. Those are later phases. Phase 6 is a *controlled brain*: it proposes and decides, and never acts outside the system.

Architecture details: [`docs/phase-6-architecture.md`](docs/phase-6-architecture.md).

---

## Quick start

Requirements: Node.js ≥ 22.12, npm.

```bash
npm install
cp .env.example .env          # optional: add a provider (see below)
npm run db:seed               # creates data/jovi.db, runs migrations, loads Jovi's identity/strategy/memory
```

Run a goal from the CLI — offline, with the deterministic mock provider (no model, no API key):

```bash
npm run jovi -- --mock "Create an Instagram Reel concept introducing Jovi to a new audience."
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
  -d '{"goal":"Create an Instagram Reel concept introducing Jovi to a new audience."}'
```

> The API needs at least one available model. Without keys or Ollama, start it with
> `JOVI_ENABLE_MOCK_PROVIDER=true npm run start:dev`.

---

## Model providers

Only **one** provider is required. Unconfigured providers report `unavailable`; they never crash the app. Check status any time:

```bash
npm run jovi:providers        # or GET /api/models
```

| Provider | Configure | Notes |
|---|---|---|
| Ollama (local) | `OLLAMA_URL` (default `http://localhost:11434`), optional `OLLAMA_MODEL` | Installed models are detected. Nothing is downloaded automatically. Cost recorded as `estimatedApiCost = 0`, `executionCostType = LOCAL_COMPUTE`. |
| Anthropic | `ANTHROPIC_API_KEY`, optional `ANTHROPIC_MODEL` | |
| OpenAI | `OPENAI_API_KEY`, optional `OPENAI_MODEL` | |
| Gemini | `GEMINI_API_KEY`, optional `GEMINI_MODEL` | |
| Mock | `JOVI_ENABLE_MOCK_PROVIDER=true` or CLI `--mock` | Deterministic canned output. **No real inference.** Results are labeled `provider: mock`. |

### Using Ollama

```bash
ollama pull llama3.1:8b       # any chat model you choose — Jovi Core never pulls models itself
OLLAMA_MODEL=llama3.1:8b npm run jovi -- "Create an Instagram Reel concept introducing Jovi to a new audience."
# Real-model integration test:
JOVI_OLLAMA_INTEGRATION=1 OLLAMA_MODEL=llama3.1:8b npm run test:ollama
```

Small local models may occasionally return invalid JSON. The router asks once for a repair, then falls back to the next available model; the job retries temporary failures.

### Routing policy

| Tier | Policy |
|---|---|
| LOW | Prefer local (Ollama); cloud as fallback |
| NORMAL | Prefer configured cloud (`JOVI_CLOUD_PREFERENCE`); local as fallback |
| HIGH | Cloud; local only as a flagged *degraded* fallback |
| STRATEGIC | Cloud, plus an independent evaluator model when available |

Privacy `LOCAL_ONLY` restricts to local models. The mock provider, when enabled, is always the last resort. Every attempt is recorded in `model_runs` (provider, model, category, reason, fallback, latency, tokens, estimated cost, success/failure) and surfaced as `MODEL_SELECTED` / `MODEL_FALLBACK` events.

---

## CLI

```bash
npm run jovi -- "<goal>"                  # execute a goal
npm run jovi -- --mock "<goal>"           # enable the mock provider
npm run jovi -- --tier STRATEGIC "<goal>" # override routing tier
npm run jovi -- --json "<goal>"           # raw JSON result
npm run jovi -- --providers               # provider status
npm run jovi -- --identity                # Jovi's active identity
```

The CLI calls the same `JoviOrchestrator.executeGoal()` as the API.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness, DB, provider availability |
| GET | `/api/jovi/identity` | Active identity + version history |
| GET | `/api/jovi/strategy` | Active strategy version |
| POST | `/api/jovi/goal` | Execute a goal (`{"goal": "...", "tier"?: "...", "mode"?: "sync" \| "async"}`) |
| GET | `/api/jovi/goal/:taskId` | Poll a goal result (async mode) |
| GET | `/api/tasks/:id` | Task + its jobs |
| GET | `/api/jobs/:id` | Job |
| GET | `/api/decisions/:id` | Decision (options, selection, evaluation, models used) |
| GET | `/api/events` | Events (`type`, `correlationId`, `entityId`, `afterSequence`, `limit`) |
| POST | `/api/memory` | Create/update a memory item |
| GET | `/api/memory` | List (`type`, `key`, `includeExpired`) or search (`q`) memory |
| GET | `/api/models` | Provider status, models table, competition availability, routing policy |
| GET | `/api/agents` | Active and planned agents, permission levels |
| POST | `/api/evaluate` | Evaluate ad-hoc options (`{objective, options}`) or a decision (`{decisionId}`) |

`POST /api/jovi/goal` response includes `taskId`, `jobId`, `decisionId`, `selectedAction`, `options`, `confidence`, `reasoningSummary`, `nextActions`, `modelsUsed`, `eventsGenerated` (plus `correlationId`, `selection`, `interpretation`, `priorities`, `contentDirection`, `evaluationSummary`, `attempts`). Status codes: `200` completed, `202` queued (async), `400` invalid input, `503` no model available, `500` other failure.

Set `JOVI_API_TOKEN` to require `Authorization: Bearer <token>` on all `/api` routes. The server binds to `127.0.0.1` by default.

---

## What's inside

- **Executive Agent** (`src/agents/executive`) — interprets the goal, generates 2–5 options, has them evaluated, selects one, delegates next actions, persists decision + memory.
- **Agent contract + runner** (`src/agents`) — validate input → load context → execute → validate output → persist → emit → return. Ten further agents are registered as *planned* (research, trends, strategy, ideation, script, visual, qa, publishing, analytics, learning).
- **Context Engine** — bounded assembly of identity, strategy, relevant memory, knowledge excerpts, recent decisions, similar past concepts and constraints. Never dumps the database.
- **Evaluator** — independent second model (quality, brandFit, objectiveFit, originality, audienceFit, risk, cost on a labeled 1–5 scale) plus deterministic rule checks (AI transparency, privacy, platform safety, clichés, pillar alignment, personality). Options that fail hard rules cannot be selected.
- **Memory** — operational (SQLite, types `IDENTITY` … `TEMPORARY`, importance/confidence/source/expiry), knowledge (`knowledge/jovi/*.md`), semantic (interface + lexical baseline, clearly labeled non-vector).
- **Events** — persisted bus with `eventId, eventType, timestamp, source, entityId, payload, schemaVersion, correlationId, causationId`.
- **Tasks & jobs** — SQLite-backed, retries with exponential backoff, crash recovery, in-process or standalone worker (`npm run worker`).
- **Permissions** — `LEVEL_0_READ` … `LEVEL_5_INFRASTRUCTURE`. Executive = `LEVEL_2_MODIFY`; deployment ceiling `LEVEL_3_EXECUTE`. No shell/filesystem/credential tools exist.
- **Prompts** (`prompts/`) and **knowledge** (`knowledge/jovi/`) live outside TypeScript.

## Project layout

```
apps/        api (Fastify) · orchestrator (CLI, worker) · dashboard (planned)
src/         agents · core · models · memory · integrations · database · types
prompts/     system · executive · evaluation · agents
knowledge/   jovi/ character-bible · voice-guide · visual-bible · content-strategy · privacy-boundaries
tests/       unit · integration (e2e with mocked providers; optional Ollama test)
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
npm test                # no network, no API keys, no local model required
npm run build
```

## Docker

```bash
docker compose up --build                          # API on 127.0.0.1:3000, data in ./data
OLLAMA_URL_DOCKER=http://ollama:11434 docker compose --profile ollama up --build   # with bundled Ollama
```

By default the container reaches a host Ollama at `host.docker.internal:11434`.

## Security & observability

- Secrets only come from environment variables; `.env` is git-ignored; logs redact key/token fields and config is logged as `configured`/`missing`.
- Model output is only ever parsed as data (Zod-validated JSON) — never executed.
- Structured JSON logs (pino) carry `taskId`, `jobId`, `correlationId`, `agent`, `provider`, `model`, `durationMs`, retries and errors. Everything is also queryable from SQLite (`tasks`, `jobs`, `agent_runs`, `model_runs`, `events`, `decisions`).
- Cost: cloud runs record list-price estimates (or `null` when pricing is unknown); local runs record `0` with `LOCAL_COMPUTE`; mock runs `0` with `NONE`.

## Known limitations (Phase 6)

- Semantic memory is a lexical baseline behind the `SemanticMemory` interface; vector search comes later.
- Model competition is availability-only (generator vs independent evaluator); multi-model generation contests are future work.
- Goal tiering uses a keyword heuristic (overridable with `tier`).
- Pricing figures are configurable estimates in `src/models/pricing.ts`.
- No dashboard, publishing, image/video generation, analytics ingestion or n8n integration yet.
