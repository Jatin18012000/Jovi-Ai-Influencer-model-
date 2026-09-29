# Phase 8 — Creative Production Layer (architecture)

```
Phase 7 IdeationOutput (ideas[], recommendedIdeaIds[])
        │  (goal → planning first, or an existing planningTaskId, or an explicit idea)
        ▼
CREATIVE_PRODUCTION task ── one SQLite job "creative.production" (retries, heartbeat, crash recovery)
        │
        ├─ SCRIPTING        ScriptAgent        (LEVEL_2, model: HIGH)    → SCRIPT artifact
        ├─ STORYBOARDING    StoryboardAgent    (LEVEL_2, model: NORMAL)  → STORYBOARD artifact
        ├─ PROMPTING        VisualPromptAgent  (LEVEL_2, model: NORMAL)  → VISUAL_PROMPTS artifact
        ├─ GENERATING_ASSETS  ┌ ImageGenerationAgent (LEVEL_3, media.image.generate)
        │                     ├ VideoGenerationAgent (LEVEL_3, media.video.generate)   in parallel*
        │                     └ VoiceAgent           (LEVEL_3, media.voice.generate)
        ├─ EDITING          EditingAgent (LEVEL_3, deterministic EDL; media.edit.render)  → EDIT_PLAN
        ├─ QA               QAAgent (LEVEL_2; deterministic checks + model review)        → QA_REPORT
        ▼
AWAITING_HUMAN_APPROVAL (QA PASS / PASS_WITH_WARNINGS)   or   BLOCKED (QA FAIL / BLOCKED)
        │
        └─ human only: recordHumanDecision → APPROVED | REJECTED     (no PUBLISHED state exists)
```

\* Video waits for images only when the selected video provider animates source images
(`supportsImageToVideo`); voice never waits for visuals.

## Components

| Layer | File | Responsibility |
|---|---|---|
| Pipeline | `src/agents/production/production-pipeline.ts` | Request validation, Phase 7 hand-off, task/job creation, stage-resuming job handler, parallel asset generation, result assembly |
| Text agents | `src/agents/production/creative-agents.ts` | Script / Storyboard / Visual Prompt agents over the Model Router; identity guard inside the parse step |
| Media agents | `src/agents/production/media-agents.ts` | Image / Video / Voice agents (one media tool each) and the deterministic Editing agent |
| QA | `qa-engine.ts`, `qa-agent.ts` | Structured QA report; model review optional, never assumed |
| Contracts | `production-schemas.ts` | Zod schemas for every artifact |
| Identity guard | `identity-guard.ts` | Age / minor depiction / origin / AI transparency / explicit / real-person likeness |
| Productions | `src/core/production/production-service.ts` | Production state machine, versioned artifacts, human decision, publishing gate |
| Assets | `asset-service.ts` | Asset lifecycle state machine + events |
| Media calls | `media-service.ts` | The **only** caller of media providers; provider selection, retries, output verification |
| Providers | `src/media/providers/*` | ComfyUI image/video, Google Flow (NOT_INTEGRATED), simulated (simulation mode only) |
| Registry | `src/media/media-provider-registry.ts` | Availability, selection, simulation isolation |
| Storage | `src/media/media-store.ts` | Confined media directory (validated ids and extensions) |
| Visual identity | `src/core/identity/visual-identity.ts` | Versioned, human-approved appearance anchors; canonical character lock |

## Structural governance (not prompt-based)

- **No publish path:** no ToolKit method, tool grant, API route, event type or production state publishes. `social.publish` is LEVEL_4 (above the deployment ceiling) and only the PLANNED publishing agent lists it.
- **Human-only approval:** `ProductionService.advance()` refuses `APPROVED`/`REJECTED`. `recordHumanDecision()` requires `AWAITING_HUMAN_APPROVAL` and a QA verdict of `PASS` (or `PASS_WITH_WARNINGS` + `acknowledgeWarnings`).
- **No fake assets:** `AssetService` refuses `COMPLETED` without a provider and location and for simulated assets; `MediaService` requires a non-MOCK provider plus a verified non-empty file inside the media root (or an https URL). No provider → `BLOCKED` with the reason.
- **Simulation isolation:** model and media registries each refuse to mix MOCK with real providers; simulated media is `SIMULATED` (location `simulation://…`) and blocks QA and the publishing gate.
- **Identity immutability:** agents get read-only identity/visual-identity tools. Creative output is checked by the identity guard at parse time (violations → `InvalidModelOutputError` → router repair/fallback → failure). The visual character lock is injected by code from the active visual identity, never written by the model.

## Data

Tables (migration `0002_phase8_creative_production.sql`): `visual_identity_versions`, `productions`, `production_artifacts` (SCRIPT, STORYBOARD, VISUAL_PROMPTS, EDIT_PLAN, QA_REPORT; versioned), `media_assets`.

## Resume semantics

Each stage persists its artifact before the production advances. A retried job resumes at the current production status; a stage whose artifact already exists is not re-run. Media kinds already generated are skipped; assets left `REQUESTED/QUEUED/GENERATING` by a crash are marked `FAILED` ("interrupted").
