# NotebookLM Project Note — Jovi Creator OS, Phase 6 (Jovi Core v0.1)

**Last revised:** 2026-09-29 — hardening pass + LM Studio migration.
**Status:** Phase 6 implementation complete and hardened. **Not yet verified against a real model**: the build environment could not reach the owner's LM Studio (it runs on the owner's MacBook, and no model is loaded yet). All automated verification used a fake LM Studio HTTP server or test doubles.

## What Jovi is
Jovi (Jovira), 25, from London, UK, with Indian, Russian and Western heritage — an openly AI global lifestyle virtual creator who must never claim to be human. Community: "Jovi's Crew". Golden rule: "Jovi should never sound like an AI writing an Instagram caption." Core pillars: Travel & Exploration, Fashion & Beauty, Entertainment & Personality.

## What Phase 6 built
A TypeScript modular monolith (Fastify, SQLite + Drizzle, Zod, Vitest):

Goal → Task → Job → Context → Executive Agent → Model Router → LM Studio or cloud model → Zod-validated output → Evaluation → Decision → Memory → Events → completed Job → API/CLI result.

- **Local model runtime:** LM Studio only (`LMStudioProvider`, OpenAI-compatible local API at `http://localhost:1234/v1`). It discovers which models are loaded and reports itself unavailable — with the fix — when the server is off or no model is loaded. Ollama was removed.
- **Cloud:** Anthropic, OpenAI, Gemini; each reports unavailable without a key.
- **Routing:** LOW/local tasks → LM Studio (cloud fallback configurable); NORMAL/HIGH/STRATEGIC → cloud, LM Studio as fallback; `LOCAL_ONLY` → LM Studio only. Fallback is logged per attempt.
- **Mock:** simulation/test only. It can never be registered next to real providers, and simulated results are flagged.
- **Security:** permissions enforced through a per-run ToolKit (every tool call audited); memory from the API is untrusted, restricted and rendered as escaped data; prompts take identity from the active database version; external next actions always need human approval; the API refuses unauthenticated network exposure and rate-limits goals.
- **Reliability:** jobs heartbeat while running; abandoned jobs are recovered on restart. `.env` is loaded automatically.

## Verification (this environment)
Typecheck and build pass. 139 automated tests pass (2 real-LM-Studio tests skipped by design). The compiled API and CLI completed the full flow against a fake LM Studio server process, and degraded gracefully (503, clear LM Studio status) with nothing running.

## Next step to finish Phase 6
On the MacBook: load a model in LM Studio, start its server, then run `npm run test:lmstudio:real` and `npm run jovi -- --local-only "<goal>"`, and record the result.

## Next phase candidates
Script, visual and QA agents; human approval queue; vector semantic memory; n8n for external actions; analytics → learning → strategy loop.
