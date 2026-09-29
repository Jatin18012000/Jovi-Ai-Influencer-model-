# NotebookLM Project Note — Phase 9

## Jovi Creator OS — Real Media Generation

### Phase status
- **Phase 9 implementation commit:** `8338784` on branch `claude/busy-pascal-h6hvhh`. The parent is `fa032ea`, the Phase 8 real LM Studio validation note.
- **Real-provider validation so far:**
  - **ffmpeg render engine only.** It ran for real inside the Linux build container (ffmpeg 6.1.1).
  - ComfyUI, macOS `say` and ElevenLabs are implemented but have **not** run for real.
  - Google Flow is not integrated.

### How the phase was identified
The repository defines the creator loop as `Research → Strategy → Ideation → Creation → QA → Publishing → Analytics → Learning → Evolution`. The Phase 8 boundary is `Idea → Script → Storyboard → Visual Prompt → Image/Video/Voice → Editing → QA → Human Approval`.

Phase 8 validated the text stages against real LM Studio (`google/gemma-4-12b-qat`, 2/2). Its `Image/Video/Voice → Editing` segment, however, had provider contracts only:
- no voice engine
- no render engine
- ComfyUI never run against a real server

As a result the publishing gate could never pass, because no final render could exist. The knowledge base (`knowledge/jovi/visual-bible.md`) also assigns Jovi's reference sheets and the "Model / LoRA / ComfyUI workflow settings" to "the visual generation phase".

Phase 9 is therefore the **Real Media Generation** segment. The Phase 8 note's line "Phase 9 would cover publishing" was a tentative projection. Publishing now follows as Phase 10, because it needs a real, human-approved render.

### Objective
Turn the `Image/Video/Voice → Editing` segment from contracts into working, governed media generation:
- real provider adapters
- capability-based routing with fallback
- verification of every generated file
- a human path to regenerate media without re-running the text stages
- human-only locking of Jovi's visual identity

Human approval and "no publishing" are unchanged.

### Architecture implemented
- **One provider contract (`src/media/types.ts`).** Simulated, test-double and real providers all implement the same interface:
  - `capabilities()`: aspect ratios, maximum duration, image-to-video, reference images, languages, output formats
  - `inspectAvailability()`: AVAILABLE, NOT_CONFIGURED, UNREACHABLE, MISCONFIGURED or NOT_INTEGRATED
  - the generate method
- **Capability routing (`MediaProviderRegistry.candidates`).**
  - Hard requirements filter providers: aspect ratio, duration, language and privacy. `LOCAL_ONLY` excludes CLOUD providers, including as fallbacks.
  - The remaining providers are ordered by: operator preference (`JOVI_MEDIA_PROVIDER_PREFERENCE`), then soft preferences (reference images, image-to-video), then LOCAL before CLOUD, then registration order.
  - Later candidates are fallbacks, and each switch emits a `MEDIA_PROVIDER_FALLBACK` event.
- **Verified outputs (`MediaInspector`).**
  - A file is accepted only if its container signature matches the asset kind (PNG, JPEG, WEBP, GIF, MP4, MOV, WEBM, WAV, AIFF, MP3, OGG, M4A).
  - Duration and dimensions are measured, with ffprobe when configured and from file headers otherwise. Measured values replace whatever the provider claimed.
  - A SHA-256 is recorded.
  - Unverifiable output counts as a provider failure, so the next provider is tried.
- **Real adapters:**
  - `ffmpeg-render`: turns the edit plan into an h264/aac MP4 with captions as a soft mov_text subtitle track. Stills are held for their slot and voice is placed at its timeline offset. Missing scenes render black; they are listed as placeholders and block the publishing gate.
  - `macos-say`: WAV output with a human-approved system voice. The text goes via stdin, never as an argument.
  - `elevenlabs`: MP3 output with a human-approved voice id.
  - ComfyUI: now uploads the approved reference image (`{{REFERENCE_IMAGE}}`) and scene source images (`{{SOURCE_IMAGE}}` for image-to-video).
- **External process governance (`src/media/process-runner.ts`).**
  - Only provider adapters spawn binaries.
  - The binary path comes from operator configuration, and arguments are built by code.
  - `shell: false`, with a timeout kill and size-capped output.
  - This is not an agent tool.
- **Human-requested media regeneration** (`POST /api/productions/:id/regenerate-media`, CLI `--regenerate-media`):
  - allowed only from BLOCKED or AWAITING_HUMAN_APPROVAL
  - script, storyboard and visual prompts are reused
  - unusable assets, or the chosen kinds when `includeCompleted` is set, plus every render become `SUPERSEDED`, which keeps them for audit
  - media is generated per scene or section, only where a gap exists
  - the edit plan and QA are redone, and the production stops at the approval boundary again
  - pipeline code cannot leave those two states on its own
- **Visual identity locking** (`POST /api/visual-identity`, CLI `--set-visual-identity`) is a human-only, versioned action. A version is LOCKED when every appearance anchor is set. Reference images must be files inside `JOVI_REFERENCE_DIR`.
- **Unchanged:**
  - model-agnostic agents
  - LM Studio as the only local LLM runtime (no Ollama)
  - cloud/local abstraction
  - event-driven state
  - SQLite job orchestration
  - QA
  - human-gated approval and no publishing path
  - modular monolith with no new services
  - no database migration: `SUPERSEDED` is a value in a text column

### Files and components changed
- **New:**
  - `src/media/media-inspector.ts`
  - `src/media/process-runner.ts`
  - `src/media/providers/ffmpeg-render-provider.ts`
  - `src/media/providers/voice-providers.ts`
  - `docs/phase-9-architecture.md`
  - this note
- **Updated:**
  - `src/media/types.ts` (capabilities, requirements, preferences, `capabilityMismatch`)
  - `media-provider-registry.ts` (candidates, preference, duplicate-id refusal)
  - `media-store.ts` (reference directory, `prepare`, sidecars)
  - `providers/index.ts`, `comfyui-providers.ts`, `simulated-providers.ts`, `unintegrated-providers.ts`
  - `src/integrations/comfyui/comfyui-client.ts` (`uploadImage`)
  - `src/core/production/media-service.ts` (fallback, verification, measurement)
  - `asset-service.ts` (`SUPERSEDED`, `annotate`, `listActive`)
  - `production-service.ts` (`requestMediaRegeneration`, human-gated states)
  - `publishing-gate.ts` (ignores superseded assets, blocks placeholder renders)
  - `src/agents/production/media-agents.ts` (privacy, requirements, preferences, active assets, section filter)
  - `production-pipeline.ts` (`regenerateMedia`, per-scene generation)
  - `qa-engine.ts` (active assets only)
  - `src/core/identity/visual-identity.ts` (`listVersions`, reference validation, input schema)
  - `src/core/jobs/task-service.ts` (`listChildren`)
  - `src/core/config/config.ts` (Phase 9 media configuration)
  - `src/core/bootstrap.ts`
  - `src/types/enums.ts` (4 events, `SUPERSEDED`)
  - `apps/api/server.ts` (3 routes, capabilities, health phase 9)
  - `apps/orchestrator/cli.ts` (4 options, capability display)
  - `.env.example`, `README.md`, `src/integrations/README.md`
- **Not changed:** `package.json`. No new scripts were needed; the real media test runs with `npx vitest`.

### Tests
| Category | File | Tests | What it proves |
|---|---|---|---|
| Deterministic unit | `tests/unit/media-generation.test.ts` | 16 | Capability matching; discovery and selection order; privacy exclusion; duplicate ids; inspector (signatures, measurement, rejection of empty, HTML or wrong-kind files); ffmpeg command and SRT builders; `say` voice parsing; process runner (stdin, ENOENT, timeout); media-tool permission enforcement including the deployment ceiling; MediaService fallback, verification-driven fallback, measured duration, and LOCAL_ONLY giving BLOCKED |
| Fake-server / fake-binary integration | `tests/integration/media-providers-fake.test.ts` | 11 | ComfyUI capabilities from placeholders, reference and source uploads, path confinement, verified COMPLETED through MediaService; ElevenLabs discovery states, request shape, 429/400 classification, no key leakage; `say` via a stand-in binary (stdin text, arguments, WAV duration); ffmpeg NOT_CONFIGURED, UNREACHABLE and MISCONFIGURED; unrenderable plan and out-of-store input refusal |
| Test-double pipeline | `tests/integration/media-regeneration.e2e.test.ts` | 6 | BLOCKED → operator configures providers → regeneration reaches AWAITING_HUMAN_APPROVAL with no text re-generation; `includeCompleted` per kind; regeneration refused after approval; fallback inside the pipeline; LOCAL_ONLY never calls cloud; visual identity lock API, regenerate API, capabilities API |
| Real-provider E2E (gated) | `tests/integration/media.real.test.ts` | 5 (2 ran here) | ffmpeg discovery and a full-pipeline real render (ran); ComfyUI, `say`, ElevenLabs (skipped: not configured here) |

- **Existing tests:** five were updated because behaviour changed intentionally: new providers are registered, reasons are now per provider, duplicate provider ids are refused, and BLOCKED gained a human-only path to GENERATING_ASSETS. None were loosened.
- **Test doubles:** they now write real file signatures, so the old media-provider and pipeline tests also go through verification.

### Typecheck / build results (this environment)
- `npm run typecheck`: PASS
- `npm test`: **227 passed, 9 skipped** (24 files: 21 passed, 3 skipped). The skipped tests are the opt-in real-model and real-media tests.
- `npm run build`: PASS
- `npm run jovi:providers` (nothing configured): all six media providers are listed. Five show NOT_CONFIGURED and google-flow shows NOT_INTEGRATED. With `JOVI_FFMPEG_PATH=ffmpeg`, ffmpeg-render shows AVAILABLE with its capabilities.

### Real-provider validation status
**REAL ffmpeg RENDER E2E: PASS (build container, not the owner's Mac)**

- Command:
  `JOVI_MEDIA_REAL=1 JOVI_FFMPEG_PATH=/usr/bin/ffmpeg JOVI_FFPROBE_PATH=/usr/bin/ffprobe npx vitest run tests/integration/media.real.test.ts`
- Result: 2 passed, 3 skipped.
- ffmpeg 6.1.1-3ubuntu5 was discovered with the libx264, aac and mov_text encoders.
- A full production ran through the pipeline:
  - canned LOCAL text model
  - ffmpeg-synthesised test-pattern image, video and tone inputs
  - the real ffmpeg render
- The render was COMPLETED: 1080×1920, 15.0 s, 22.8 MB MP4. Streams (checked with ffprobe) were h264 video, aac audio and mov_text subtitles, with no placeholder scenes.
- QA was PASS_WITH_WARNINGS and the production reached AWAITING_HUMAN_APPROVAL.
- The render inputs were test patterns. This validates the render engine and pipeline wiring, **not** image, video or voice generation quality.

| Provider | Real run? |
|---|---|
| ffmpeg render (Linux container) | **Yes — PASS** |
| ffmpeg render (owner's Mac, Homebrew ffmpeg) | No |
| ComfyUI image / video | No (fake server only) |
| macOS `say` | No (fake binary only; the build container is Linux) |
| ElevenLabs | No (fake server only; no key) |
| Google Flow | Not integrated |
| Phase 8 text agents on LM Studio | Yes, earlier: 2/2 on the owner's Mac (`fa032ea`); not re-run in Phase 9 |

### Simulated / fake-server validation status
- **Simulation mode** (`--simulate`) still produces only SIMULATED assets, and QA is BLOCKED. Media regeneration also works in simulation; this was checked with a CLI smoke test.
- **Fake servers and binaries** cover the ComfyUI, ElevenLabs, `say` and ffmpeg discovery protocols, as listed in the Tests table.

### What is NOT yet validated
- No real image or video has been generated: ComfyUI has never run against a real server. Reference-image identity conditioning and image-to-video have not been exercised on a real workflow.
- No real speech has been synthesised: neither macOS `say` nor ElevenLabs has run for real.
- The ffmpeg render has not been run on the owner's Mac (Homebrew ffmpeg 7.x). The `amix normalize` option and other flags were exercised only with ffmpeg 6.1.1.
- No end-to-end production has combined real LM Studio text with real media.
- Jovi's appearance has not been locked (no approved reference sheet exists), so identity consistency is unverified. There is no automated visual-identity inspector.

### Known limitations
1. There is no automated visual-consistency inspector; face, hair and eye consistency is a human review item.
2. Text overlays are not burned into renders; captions are a soft subtitle track. No music is selected.
3. The ComfyUI video adapter's maximum duration defaults to 10 s, and scenes longer than that are routed away. The operator's workflow decides the real limit.
4. ElevenLabs cost is not estimated (pricing depends on the plan).
5. Measured MP3 durations without ffprobe are CBR estimates.
6. Real LM Studio inference is slow (~18 minutes for the text stages). Regeneration avoids repeating it for media fixes.

### Exact next manual commands (owner's Mac)
```bash
git fetch origin claude/busy-pascal-h6hvhh && git checkout claude/busy-pascal-h6hvhh && git pull
npm install
npm run typecheck && npm test && npm run build

# 1) Render engine
brew install ffmpeg
#   add to .env (Apple Silicon paths; Intel Macs use /usr/local/bin):
#   JOVI_FFMPEG_PATH=/opt/homebrew/bin/ffmpeg
#   JOVI_FFPROBE_PATH=/opt/homebrew/bin/ffprobe

# 2) Local voice: pick and approve a voice, then set it in .env
say -v '?' | grep -i en_GB
#   MACOS_SAY_VOICE=<chosen voice name>

npm run jovi:providers
JOVI_MEDIA_REAL=1 npx vitest run tests/integration/media.real.test.ts

# 3) ComfyUI (optional now): start ComfyUI, export an API-format workflow with the
#    placeholders from .env.example, then set COMFYUI_URL / COMFYUI_IMAGE_WORKFLOW
#    and re-run the real media test above.

# 4) Full real production (LM Studio text + configured media), then human steps
npm run jovi -- --local-only --produce "Create an Instagram Reel concept that introduces Jovi to a new audience."
npm run jovi -- --production <productionId>
npm run jovi -- --regenerate-media <productionId> --requested-by "Jatin"      # after configuring more providers
npm run jovi -- --set-visual-identity jovi-visual.json --approved-by "Jatin" --summary "Lock appearance anchors"
npm run jovi -- --decide <productionId> --decision APPROVE --reviewer "Jatin" --acknowledge-warnings
```
`--local-only` keeps both text and media local, so ElevenLabs is never used for that production.

### Next phase boundary
Phase 10 is **Publishing (human-gated)**. It would take APPROVED productions with a completed, non-placeholder render to platforms. It needs:
- LEVEL_4 permission
- platform API integration
- scheduling
- an explicit per-post human confirmation

Analytics → Learning follow. Phase 9 adds no publishing code; `autonomousPublishingAllowed` remains `false`.
