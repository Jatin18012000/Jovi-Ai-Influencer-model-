# NotebookLM Project Note — Jovi Creator OS, Phase 6 (Jovi Core v0.1)

**Date:** 2026-09-29
**Status:** Phase 6 complete. The core brain works end to end. It was verified with the deterministic mock provider, because no Ollama instance or cloud API key was available in the build environment.

## What Jovi is
Jovi (Jovira), 25, from London, UK, with Indian, Russian and Western heritage. She is an openly AI global lifestyle virtual creator and must never claim to be human. Her community is "Jovi's Crew". Golden rule: "Jovi should never sound like an AI writing an Instagram caption." Core pillars: Travel & Exploration, Fashion & Beauty, Entertainment & Personality. Content philosophy: Experience → Story → Personality → Community.

## What Phase 6 built
A TypeScript modular monolith that turns a goal into an auditable, structured creative decision:

GOAL → Executive Agent → Context Engine → Model Router → Model → Zod-validated proposal → Evaluator (a second model plus rule checks) → selection → persisted Decision and Memory → events → result (API and CLI).

- **Stack:** Node.js 22, TypeScript (strict), Fastify, SQLite + Drizzle (13 tables, migrations, seed), Zod, Vitest, pino.
- **Executive Agent:** permission LEVEL_2_MODIFY. Produces an objective, interpretation, priorities, content direction, 2–5 options, the selected option, a rationale summary, a confidence score and next actions. External actions such as publishing come back as REQUIRES_APPROVAL.
- **Model Router:** tiers are LOW (local first), NORMAL (cloud first), HIGH (cloud, with local as a flagged degraded fallback) and STRATEGIC (cloud plus an independent evaluator). There is a privacy LOCAL_ONLY mode. The router repairs invalid JSON once, then falls back to the next provider. Every attempt is logged in `model_runs`.
- **Providers:** Ollama (detects installed models and never pulls any), Anthropic, OpenAI, Gemini, and a mock provider for offline runs. A provider without credentials reports itself as unavailable instead of crashing.
- **Evaluator:** scores quality, brandFit, objectiveFit, originality, audienceFit, risk and cost on a 1–5 scale, labeled as model judgements. Rule checks cover AI transparency, privacy, platform safety, clichés, pillar fit and personality. An option that fails a hard rule cannot be selected.
- **Memory:** operational memory in SQLite (10 types, with importance, confidence, source and expiry), knowledge in Markdown files, and a semantic interface. The semantic layer is currently a keyword baseline, not vector search.
- **Events:** a persisted bus. Each event carries a correlationId and a causationId chain.
- **Tasks and jobs:** SQLite-backed, with retry and backoff, crash recovery and async worker mode.
- **Permissions:** Levels 0–5. The deployment ceiling is LEVEL_3. The system has no shell, filesystem or credential tools.

## Verification
The TypeScript check passes and the build succeeds. The suite has 100 tests, all passing without network access or paid APIs; 2 Ollama integration tests are skipped because no Ollama was running. The API was exercised over real HTTP, and the CLI ran against a fresh database.

## Known limitations
- Semantic memory is lexical, not vector.
- Model competition only reports whether a second model is available.
- Goal tiering uses a keyword heuristic.
- Pricing figures are estimates.
- There is no dashboard, publishing, media generation, analytics or n8n integration yet.
- The Docker image was not built in this environment.

## Next phase candidates
Specialist agents (script, visual, QA), human approval queue, vector semantic memory, n8n integration for external actions, analytics → learning → strategy versioning loop.
