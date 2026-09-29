# Jovi Creator OS — Phase 7 Architecture

## Purpose

Phase 7 activates the first creator-intelligence layer above the Phase 6 executive brain.

```
Goal
  ↓
Research Agent
  ↓
Trend Intelligence Agent
  ↓
Strategy Agent
  ↓
Ideation Agent
  ↓
Structured Planning Result
```

The pipeline is planning-only. It does not publish, message, contact people, activate strategy, or execute external actions.

## Agents

| Agent | Permission | Output |
|---|---|---|
| Research | LEVEL_1_GENERATE | Research findings, audience angles, risks |
| Trends | LEVEL_1_GENERATE | Trend/content signals, Jovi fit, freshness, avoid list |
| Strategy | LEVEL_1_GENERATE | Strategy proposal, formats, experiments, guardrails |
| Ideation | LEVEL_1_GENERATE | 5–8 content ideas and recommendation |

All four agents use the existing AgentRunner and permission-enforced ToolKit. They never receive system services directly.

## Model routing

Every stage uses the existing ModelRouter. The pipeline is provider/model agnostic.

- Research: NORMAL
- Trends: LOW
- Strategy: STRATEGIC
- Ideation: HIGH

If only LM Studio is available, the existing router may mark HIGH/STRATEGIC execution as degraded local inference. No cloud provider is required by the planning implementation itself.

## Research truthfulness

Phase 7 does not yet contain a web-search connector. Therefore the Research and Trends agents must not claim live web/social verification. Their structured source types distinguish:

- KNOWLEDGE_BASE
- MEMORY
- MODEL_KNOWLEDGE

Trend freshness labels are descriptive planning labels, not evidence that a platform trend is currently viral.

## Persistence

A planning run creates one `CREATOR_PLANNING` task. Each agent execution is recorded in `agent_runs`. The completed planning packet is stored in the parent task result.

No new database tables are required for this phase.

## Strategy safety

The Strategy Agent proposes changes but does not call strategy mutation services. The active strategy therefore cannot be silently replaced by model output.

## Interfaces

CLI:

```bash
npm run jovi:plan -- "Plan Jovi content around London fashion and travel."
```

API:

```
POST /api/jovi/planning
Content-Type: application/json

{"goal":"Plan Jovi content around London fashion and travel."}
```

## Phase 8 boundary

The selected idea is still not a produced asset. Phase 8 should convert planning outputs into script, storyboard, visual prompt, image/video/voice generation requests and QA while preserving approval boundaries.
