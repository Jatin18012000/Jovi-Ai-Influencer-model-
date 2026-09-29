# Jovi Core v0.1 — Phase 6 Architecture

Phase 6 implements the **core brain** of Jovi Creator OS as a modular monolith (TypeScript, Node.js, Fastify, SQLite + Drizzle, Zod, Vitest). The architecture was locked in Phase 5; this document maps it to code.

## Flow

```
POST /api/jovi/goal  ─┐
npm run jovi -- "…"  ─┴─► JoviOrchestrator.executeGoal()            src/core/orchestrator/orchestrator.ts
                           │ 1. create Task (QUEUED)  ── TASK_CREATED
                           │ 2. enqueue Job (SQLite)  ── JOB_CREATED
                           ▼
                        JobQueue.run() / JobWorker                   src/core/jobs/
                           │ retries temporary failures (exp. backoff)
                           ▼ TASK_STARTED
                        AgentRunner.run(ExecutiveAgent)              src/agents/agent-runner.ts
                           │ validate input ── AGENT_STARTED
                           │ load context  ◄── ContextEngine          src/core/orchestrator/context-engine.ts
                           │                    identity · strategy · relevant memory · knowledge
                           │                    recent decisions · similar concepts · constraints
                           │ execute:
                           │   ModelRouter.generate()                 src/models/router/model-router.ts
                           │     tier policy → candidates → provider → Zod parse
                           │     repair once → fallback ── MODEL_SELECTED / MODEL_FALLBACK
                           │     every attempt → model_runs
                           │   Decision PROPOSED ── DECISION_CREATED
                           │   Evaluator (2nd model + rules) ── EVALUATION_COMPLETED, DECISION_EVALUATED
                           │   selectOption() ── DECISION_SELECTED
                           │ validate output (Zod)
                           │ persist memory ── MEMORY_CREATED/UPDATED
                           │ ── AGENT_COMPLETED
                           ▼
                        Task COMPLETED ── TASK_COMPLETED, JOB_COMPLETED
                           ▼
                        GoalExecutionResult (API/CLI)
```

## Module map

| Boundary | Path | Responsibility |
|---|---|---|
| Apps | `apps/api`, `apps/orchestrator` | Thin shells (HTTP, CLI, worker). No business logic. |
| Composition root | `src/core/bootstrap.ts` | Single wiring of the system for API, CLI, worker and tests. |
| Orchestrator | `src/core/orchestrator` | `executeGoal`, Context Engine. |
| Events | `src/core/events` | Persisted internal event bus with correlation + causation chains. |
| Jobs | `src/core/jobs` | Tasks (intent) and SQLite-backed Jobs (attempts), worker. |
| Permissions | `src/core/permissions` | Levels 0–5, tool registry, per-agent guard, deployment ceiling. |
| Identity / Strategy | `src/core/identity`, `src/core/strategy` | Versioned identity and strategy. |
| Decisions | `src/core/decisions` | Decision lifecycle persistence. |
| Prompts | `src/core/prompts` + `prompts/` | Markdown prompt templates outside TS. |
| Agents | `src/agents` | Agent contract, runner, **ToolKit** (enforced permissions), registry, Executive Agent, planned-agent roadmap. |
| Models | `src/models` | Provider interface + adapters, router, evaluator, competition, pricing. |
| Memory | `src/memory` | Operational (SQLite), knowledge (Markdown), semantic (interface + lexical baseline). |
| Integrations | `src/integrations` | LM Studio client (only local runtime) now; n8n/ComfyUI/Flow/social/storage later. |
| Database | `src/database` | Drizzle schema, migrations, seed data. |

## Key design decisions

- **One composition root.** `createJoviCore()` is used by every entry point, so the API and CLI cannot drift.
- **Task vs Job.** A Task is what Jovi wants done; a Job is an execution attempt with retries. Synchronous requests *reserve* their job so the background worker never steals it between retries.
- **Router owns fallback; jobs own retries.** The router tries every candidate model once (plus one JSON repair); if all fail temporarily the job is retried with backoff.
- **Evaluator independence.** The evaluator excludes the generator's model. With no second model it runs deterministic rule checks only and reports `modelCompetition.available = false`.
- **Coarse, labeled scores.** Model scores are 1–5 ordinal judgements, labeled as such; rule checks are PASS/WARN/FAIL. No fake precision.
- **No chain-of-thought storage.** Decisions store `reasoningSummary` only; prompts instruct models to return concise summaries.
- **Controlled brain.** The Executive Agent holds `LEVEL_2_MODIFY`. Next actions needing `LEVEL_4`+ (publishing, messaging) are returned as `REQUIRES_APPROVAL`. There are no shell, filesystem or credential tools.
- **Strategy as data.** Cadence and content-mix numbers are stored as `GUIDELINE` values in a versioned strategy row, not constants in code.

## Database tables

`jovi_identity`, `identity_versions`, `strategy_versions`, `agents`, `agent_runs`, `models`, `model_runs`, `tasks`, `jobs`, `events`, `decisions`, `evaluations`, `memory_items`.

Migrations: `src/database/migrations` (generated by drizzle-kit from `src/database/schema.ts`), applied automatically at startup and by `npm run db:migrate`.

## Phase 6 hardening + LM Studio migration

**Local runtime.** LM Studio is the only local-model runtime (`LMStudioProvider`, provider id `lmstudio`, kind `LOCAL`, cost `0` / `LOCAL_COMPUTE`). Ollama was removed entirely; obsolete `OLLAMA_*` variables only produce a configuration warning.

```
Executive Agent → ToolKit (models.generate) → Model Router → LMStudioProvider → LM Studio (/v1/chat/completions)
                                                          ↘ Anthropic / OpenAI / Gemini (per routing policy)
```

- Discovery: `/api/v1/models` (LM Studio ≥ 0.4) → `/api/v0/models` → OpenAI-compatible `/v1/models`. Unavailable (never an exception) when the server is down, no chat model exists, `LM_STUDIO_MODEL` is missing, or no model is loaded.
- Timeouts are per provider; the router no longer caps them (LM Studio default 10 min).

**Controlled tool layer (H4).** `AgentRunner` is the only holder of services. Each run gets a `ToolKit` bound to the agent's `PermissionGuard` (allow-list + level, capped by the deployment ceiling). Every call is audited in `agent_runs.tool_calls`; agent memory writes are forced to `source = agent:<name>`.

**Mock isolation (M2).** The `ProviderRegistry` refuses to register the MOCK provider alongside real providers. Simulation mode (`JOVI_SIMULATION_MODE` / `--simulate`) registers only the mock, and results carry `simulated: true`.

**Job recovery (H5).** Running and reserved jobs refresh `locked_at` via heartbeat. `recoverStale` (at every startup and periodically in the worker) re-queues abandoned RUNNING jobs, fails those with no attempts left (running the final-failure hook, which fails the task), and releases orphaned QUEUED/RETRYING reservations.

**Untrusted data (M1).** External memory (API) is restricted in type, forced to `source = api`, capped in importance/confidence and size, and cannot overwrite seed/agent memory. The Context Engine renders memory and knowledge inside escaped `<memory_data>` / `<knowledge_data>` blocks with trust labels.

**Identity (M3).** Prompt files are identity-agnostic templates rendered from the active identity version (`src/core/identity/identity-prompt.ts`).

**Rule checks (C1).** Only published/performed content fields are scanned; negated or safeguard phrasing ("never reveal her address", "non-explicit") is not a violation.

**Actions (M4).** Required level = max(text classification, owning agent's level); external or unknown-owner actions require approval.

**API exposure (M5).** Non-loopback bind requires `JOVI_API_TOKEN`; goal/evaluate endpoints are rate limited and concurrency capped.

Schema change: migration `0001_agent_tool_calls` adds `agent_runs.tool_calls`.
