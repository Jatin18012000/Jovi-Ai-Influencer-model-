# NotebookLM Project Note — Phase 8

## Jovi Creator OS — Creative Production Layer

### Phase status
Phase 8 is implemented on branch `claude/busy-pascal-h6hvhh` on top of Phase 7. Everything runs and is tested with deterministic tests, a mock text model, test-double media providers and a fake ComfyUI HTTP server. **Phase 8 is not externally validated:** no real ComfyUI, Google Flow, voice engine or editing engine has been executed, and the Phase 8 text agents have not yet been run against a real LM Studio model in this environment (LM Studio was not reachable from the build container).

### Objective
Turn a Phase 7 idea into a reviewable production package: script, storyboard, identity-locked visual prompts, media assets (where a real provider exists), an edit plan and a structured QA report. The package then stops at the human approval boundary. Jovi does not publish.

### Architecture
`Idea → Script → Storyboard → Visual Prompt → Image ∥ Video ∥ Voice → Editing → QA → Human approval boundary`

- The pipeline reuses the existing core: AgentRunner, per-run permission ToolKit, TaskService, SQLite JobQueue (retries, heartbeat, crash recovery), EventBus, Model Router and Evaluator rule checks.
- There is no parallel planning system. A production starts from Phase 7 output in one of three ways:
  - a goal, which runs Phase 7 first;
  - an existing planning task id, optionally with an idea id; the default is `recommendedIdeaIds[0]`;
  - an explicit idea.
- Each production is one `CREATIVE_PRODUCTION` task executed by one job. Each stage persists a versioned artifact, so a retried job resumes where it stopped.
- Image, video and voice generation run in parallel. Video waits for images only when the video provider animates source images.

### Agents
| Agent | Level | Tools | Output |
|---|---|---|---|
| Script | LEVEL_2 | identity/strategy/knowledge read, model.generate, production.read/write | Sections, dialogue, on-screen text, CTA, intents |
| Storyboard | LEVEL_2 | same | Scenes: location, action, camera, framing, lighting, wardrobe, continuity |
| Visual Prompt | LEVEL_2 | same | Per-scene image/video/negative prompts plus the canonical character lock |
| Image Generation | LEVEL_3 | identity.read, production.read, media.image.generate | Image assets |
| Video Generation | LEVEL_3 | identity.read, production.read, media.video.generate | Video assets |
| Voice | LEVEL_3 | identity.read, production.read, media.voice.generate | Voice assets per section |
| Editing | LEVEL_3 | production.read/write, media.edit.render | Deterministic edit decision list, plus a render request |
| QA | LEVEL_2 | same as the text agents | QA report |

The text agents are routed through the Model Router. They are not tied to any provider (LM Studio, cloud, or simulation in simulation mode).

### Schemas
All artifacts are validated with Zod: ProductionIdea, Script, Storyboard, VisualPrompts, MediaAgentOutput, EditPlan, QAReport and QAModelReview.

The Phase 7 `IdeationOutput` now has:
- stable idea ids (`idea-N`)
- `personalityTraits` and `audienceValue`
- `recommendedIdeaIds` (1–3), with legacy `recommendedIdeaId` accepted and normalised

### Governance (structural)
- **Publishing:**
  - No tool, ToolKit method, API route, event type or production state publishes.
  - The publishing gate always returns `autonomousPublishingAllowed: false`.
  - Publishing remains a PLANNED LEVEL_4 agent.
- **Human approval:**
  - Only `recordHumanDecision` sets APPROVED or REJECTED.
  - Approval requires QA PASS, or PASS_WITH_WARNINGS with the warnings acknowledged.
  - QA FAIL or BLOCKED can only be rejected.
- **Identity:**
  - Agents get read-only identity tools.
  - Creative output passes an identity guard at parse time, covering age 25, no minor depiction, London origin, openly AI, no explicit content and no real-person likeness in prompts. A violation is repaired by the router or the run fails.
  - The character lock comes from the versioned visual identity, never from the model.
- **No fake assets:**
  - COMPLETED requires a real (non-mock) provider and a verified output file.
  - A missing provider gives BLOCKED with the reason.
  - Simulation gives SIMULATED.

### Visual identity
Jovi's appearance anchors (face, hair, eyes, skin, beauty mark, body, signature style) are **not locked**; the knowledge-base visual bible says they are to be locked later. The seeded visual identity v1 is therefore NOT_LOCKED, and QA reports identity visual consistency as BLOCKED until a human records a locked version.

### Provider architecture
| Kind | Provider | State in this build |
|---|---|---|
| Image | ComfyUI (`comfyui-image`, LOCAL) | Implemented; NOT_CONFIGURED until `COMFYUI_URL` and `COMFYUI_IMAGE_WORKFLOW` are set. Tested only against a fake ComfyUI server. |
| Video | ComfyUI (`comfyui-video`, LOCAL) | Implemented (text-to-video workflows only); same configuration and testing status |
| Video | Google Flow (`google-flow`, CLOUD) | NOT_INTEGRATED; there is no executable API integration |
| Voice | none | Interface only; assets BLOCKED (PROVIDER_NOT_CONFIGURED) |
| Editing/render | none | Interface only; the edit plan is produced but the render is BLOCKED |
| Simulation | simulated image/video/voice/render (MOCK) | Only in `JOVI_SIMULATION_MODE`; never mixed with real providers |

The asset lifecycle is REQUESTED → QUEUED → GENERATING → COMPLETED / SIMULATED / FAILED. BLOCKED means no provider was available, and REJECTED means a human rejected the production.

### QA
Checks fall into seven categories: identity, personality, brand, content, visual, safety and technical.
- **Deterministic checks** decide identity, safety and technical integrity: age, origin, character lock, AI transparency, privacy, likeness, claims, aspect ratio, duration, asset presence and A/V sync.
- **The QA model** judges tone, dialogue, behaviour, voice, audience fit, hook, narrative, pacing and originality.
- **Unverifiable checks** are NOT_VERIFIABLE (human review), never PASSED. Examples: face consistency with no visual inspector, or a missing QA model.
- **Status** is PASS, PASS_WITH_WARNINGS, FAIL or BLOCKED.
- **Scores** are fractions of evaluated checks that passed. They are not quality percentages.

### Interfaces
- CLI:
  - `npm run jovi -- --produce "<goal>"`
  - `--produce --from-plan <taskId> [--idea idea-2]`
  - `--production <id>`
  - `--decide <id> --decision APPROVE|REJECT --reviewer "<name>" [--acknowledge-warnings]`
  - `--simulate` for simulation
- API:
  - `POST /api/productions`
  - `GET /api/productions/:id` and its `/script`, `/storyboard`, `/visual-prompts`, `/edit-plan`, `/qa`, `/assets` and `/publishing-gate` sub-resources
  - `POST /api/productions/:id/decision`
  - `GET /api/media/providers`

### Testing
- **Deterministic:** idea contract, schemas, identity guard, QA engine outcomes, state machines, publishing gate, agent permission grants, MediaStore confinement.
- **Mock provider and test doubles:**
  - Full pipeline with a LOCAL canned text model and LOCAL test-double media providers that write real files. This covers:
    - reaching AWAITING_HUMAN_APPROVAL and the human approval flow
    - image-conditioned video ordering
    - starting from a planning task and idea id
    - QA FAIL blocking approval
    - identity-violation repair and failure
    - job retry resuming at the failed stage
    - a failing media provider
  - Missing providers giving BLOCKED, not fake assets.
  - Simulation isolation.
  - The "cannot publish" audit.
  - API endpoints.
  - The ComfyUI adapter against a fake ComfyUI HTTP server.
- **Real LM Studio:** `npm run test:production:real` (opt-in) runs the text agents on LM Studio. It was not executable here because LM Studio was unreachable.
- **Real external media:** none. No real ComfyUI, Flow, voice or editing engine has been executed.

### Limitations
- ComfyUI has never been run against a real server, and the video adapter is text-to-video only (no source-image upload).
- Google Flow, voice and editing/render are not integrated.
- There is no automated visual-consistency inspector, and visual identity anchors are not locked.
- Music is not selected (licensing needs a human).
- One model per provider is routed; the QA model review can come from the same model that wrote the script.

### External integration gates (before claiming real media)
1. Run ComfyUI locally with a chosen workflow, set `COMFYUI_URL` and the workflow paths, and confirm `npm run jovi:providers` shows AVAILABLE.
2. Choose and approve a voice engine and a voice for Jovi, then implement a `VoiceGenerationProvider` adapter.
3. Choose an editing/render engine (for example an ffmpeg-based renderer) and implement an `EditingRenderProvider`.
4. Decide whether Google Flow gets a supported API path. Until then it stays NOT_INTEGRATED.
5. Lock Jovi's visual identity: a human approves the appearance anchors and reference sheet.
6. Run `npm run test:production:real` with LM Studio (`google/gemma-4-12b-qat`) loaded.

### Next phase boundary
Phase 9 would cover the publishing workflow for **human-approved** productions only. It would need LEVEL_4, platform API integration, scheduling and an explicit per-post human confirmation. Analytics ingestion would feed learning. Phase 8 deliberately stops at AWAITING_HUMAN_APPROVAL / APPROVED and contains no publishing code.

## Real LM Studio Validation — 29 September 2026

This section records a real run on the local machine. It supersedes the earlier statements in this note that the Phase 8 text agents had not been run against a real LM Studio model.

**Classification: REAL LM STUDIO E2E: PASS**

> This was not a clean run. Schema-output reliability and inference latency remain optimization areas.

### Verified results
- Phase 8 commit: `b698447`
- Deterministic validation: 194 tests passed, 4 skipped
- Typecheck: PASS
- Build: PASS
- Real test command:
  `JOVI_LMSTUDIO_REAL=1 npx vitest run tests/integration/production.real.test.ts`
- Real tests: 2/2 passed
- Provider: `lmstudio`
- Model: `google/gemma-4-12b-qat`
- The real Phase 8 pipeline ran successfully against the local model.
- Verified artifacts:
  - Script
  - Storyboard
  - Visual prompts
  - QA review
- Total real-model test duration: approximately 1104.72 seconds (~18.4 minutes)

### Observed issues
1. A model output initially failed schema validation because storyboard `continuityNotes.0` exceeded the 250-character maximum.
2. One LM Studio model run hit `[lmstudio] network error: fetch failed (Headers Timeout Error)` after about 301019 ms (~5 minutes).

Despite these, the test completed with 2/2 tests passing.

### Scope of this validation
The validation covers only the Phase 8 **text** agents (script, storyboard, visual prompts, QA review) on the local model. **No real image, video, voice or editing/render provider has been validated.** ComfyUI is still tested only against a fake HTTP server, Google Flow remains NOT_INTEGRATED, and no voice or render engine exists. Media assets in this run were not produced by any real media provider.
