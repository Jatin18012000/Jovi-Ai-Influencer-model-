# NotebookLM Project Note — Phase 7

## Jovi Creator OS — Research → Trends → Strategy → Ideation

### Phase status
Phase 7 implementation is committed to the `claude/busy-pascal-h6hvhh` branch.

### What Phase 7 adds
Jovi now has an executable creator-planning pipeline:

`Research → Trend Intelligence → Strategy Proposal → Ideation`

Four active agents were added:
- **Research Agent** — builds a structured research packet from Jovi's knowledge base, operational memory and model knowledge.
- **Trend Intelligence Agent** — converts research into trend/content signals and scores Jovi-fit.
- **Strategy Agent** — proposes a strategy update and experiments without activating or mutating the live strategy.
- **Ideation Agent** — generates 5–8 distinct personality-led content concepts and recommends one.

### Architecture
- Agents run through the existing `AgentRunner` and permission-enforced `ToolKit`.
- Model calls still go through the existing model router; no provider is hard-coded.
- The pipeline creates a parent `CREATOR_PLANNING` task and records each agent run against the same task/correlation.
- Outputs are structured with Zod and are persisted in the parent task result.
- No external publishing, messaging, filesystem, shell, credential or infrastructure action is introduced.
- Strategy changes are proposals only; the active strategy is not silently changed.
- Research explicitly distinguishes internal knowledge/memory/model knowledge and does **not** claim live-web verification.

### Interfaces
CLI:
`npm run jovi:plan -- "Create a content plan for Jovi around London fashion and travel."`

API:
`POST /api/jovi/planning`
Body:
`{"goal":"...","topic":"optional","constraints":["optional"]}`

### Jovi constraints preserved
- Jovi remains openly AI/virtual and never claims to be human.
- Immutable identity and privacy boundaries remain enforced.
- Core pillars remain Travel & Exploration, Fashion & Beauty, and Entertainment & Personality.
- Supporting categories remain available through the existing strategy.
- Reels remain the main discovery format and Stories remain the community format.
- Content must avoid generic influencer templates and explicit content.

### Verification
Added structured contract/registration tests in `tests/unit/planning.test.ts`.
The local Phase 6 test suite previously passed with 139 tests and 2 expected real-LM-Studio skips when no model was loaded. Phase 7 source changes still require a local `npm test`, `npm run typecheck`, and `npm run build` after pulling the commits because repository edits in this session could not execute the user's local Node environment.

### Known limitations
1. Phase 7 research has no dedicated web-search connector yet, so it cannot truthfully provide live social-platform trend verification.
2. Planning outputs are stored with the parent task; dedicated research/trend/idea database tables are deferred.
3. The planning pipeline is synchronous; background job orchestration for long planning runs can be added later.
4. Strategy activation remains intentionally outside this phase.
5. Publishing and external actions remain human-gated.

### Phase 8 handoff
Next logical phase: **Creative Production** — convert selected ideas into scripts/storyboards/visual prompts and connect controlled generation adapters (ComfyUI/Google Flow/video/voice) while preserving QA and human approval boundaries.
