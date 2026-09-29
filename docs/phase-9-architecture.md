# Phase 9 — Real Media Generation (architecture)

## Why this is Phase 9

The Phase 8 boundary is `Idea → Script → Storyboard → Visual Prompt → Image/Video/Voice → Editing → QA → Human Approval`.
Phase 8 delivered the text stages (validated against real LM Studio), QA and the human boundary, but its
`Image/Video/Voice → Editing` segment had provider **contracts only**: no voice or render engine existed,
ComfyUI had never run for real, and the publishing gate could never pass because no final render could exist.
The knowledge base also assigns Jovi's face/body/hair reference sheets and "Model / LoRA / ComfyUI workflow
settings" to "the visual generation phase" (`knowledge/jovi/visual-bible.md`). Phase 9 completes that segment.
Publishing (loop step after QA) moves to Phase 10: it depends on a real, human-approved render.

## Flow (unchanged stages, new media layer)

```
GENERATING_ASSETS ─► Image / Video / Voice agents (LEVEL_3, one media tool each; per scene/section)
                       │  MediaJob { requirements: aspectRatio, duration, language, privacy;
                       │             preferences: referenceImages, imageToVideo }
                       ▼
                     MediaService ── MediaProviderRegistry.candidates(kind, requirements, preferences)
                       │              AVAILABLE ∧ capable → ordered: operator preference > soft prefs > LOCAL > CLOUD
                       │   primary ── retries (retryable errors) ── fallback to next candidate (MEDIA_PROVIDER_FALLBACK)
                       │   output ─► MediaInspector: signature matches kind? measure duration/size (ffprobe|headers), sha256
                       ▼
                     COMPLETED (verified) | FAILED (all candidates failed / unverifiable) | BLOCKED (no capable provider)
EDITING ─► Editing agent: EDL from ACTIVE assets (newest first) ─► render request ─► ffmpeg-render (MP4)
QA ─► same Phase 8 QA over ACTIVE assets (superseded/rejected excluded); measured voice durations feed A/V sync
      └► AWAITING_HUMAN_APPROVAL | BLOCKED
Human: regenerate-media ─► BLOCKED/AWAITING → GENERATING_ASSETS (text reused, old assets SUPERSEDED) ─► … ─► boundary again
```

## Provider contract (`src/media/types.ts`)

Every provider — simulated, test double or real — implements:
`id`, `kind` (LOCAL | CLOUD | MOCK), `mediaKind`, `inspectAvailability()` (never throws; AVAILABLE /
NOT_CONFIGURED / UNREACHABLE / MISCONFIGURED / NOT_INTEGRATED), `supportedModels()`, `capabilities()`,
`estimateCost()`, and one generate method. `capabilityMismatch()` is the single matching rule.

| Provider | Kind | Enabled by | Capabilities | Validation status |
|---|---|---|---|---|
| `comfyui-image` | LOCAL | `COMFYUI_URL` + `COMFYUI_IMAGE_WORKFLOW` | all ratios; `referenceImages` iff workflow has `{{REFERENCE_IMAGE}}` | fake ComfyUI server only |
| `comfyui-video` | LOCAL | `COMFYUI_URL` + `COMFYUI_VIDEO_WORKFLOW` | max 10 s; `imageToVideo` iff workflow has `{{SOURCE_IMAGE}}` | fake ComfyUI server only |
| `google-flow` | CLOUD | — | — | NOT_INTEGRATED (no executable API) |
| `macos-say` | LOCAL | `MACOS_SAY_VOICE` (macOS) | language of the chosen voice; WAV | fake `say` binary only |
| `elevenlabs` | CLOUD | `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` | any language; MP3 | fake ElevenLabs server only |
| `ffmpeg-render` | LOCAL | `JOVI_FFMPEG_PATH` | ≤ 600 s; MP4 h264/aac + mov_text captions | **real ffmpeg 6.1.1 E2E (Linux container)** |
| `simulated-*` | MOCK | `JOVI_SIMULATION_MODE` | unlimited; SIMULATED only | simulation tests |

## Governance

- **External processes** (`src/media/process-runner.ts`): only provider adapters spawn binaries; the binary path is operator configuration; arguments are built by code from validated values and media-store paths; `shell: false`; free text (speech) goes via stdin; timeouts kill the process. This is not an agent tool — agents still have no shell/filesystem tools.
- **File confinement**: outputs are written only under `JOVI_MEDIA_DIR`; uploads/renders read only files inside the media or reference directory (`JOVI_REFERENCE_DIR`).
- **Privacy**: `LOCAL_ONLY` productions exclude CLOUD media providers, including as fallbacks.
- **No fake success**: COMPLETED requires a non-MOCK provider and a file that passes signature verification (or an https URL, marked `REMOTE_URL_NOT_INSPECTED`).
- **Human-only transitions**: approval/rejection (Phase 8) and media regeneration (Phase 9). `ProductionService.advance()` cannot move a production out of BLOCKED or AWAITING_HUMAN_APPROVAL.
- **Visual identity** changes are human-only (API/CLI) and versioned; reference images must be real files in the reference directory.
- **Publishing**: unchanged — no publish tool, route, state or event. The gate additionally blocks renders with placeholder (black) scenes.

## Data

No migration: asset `status` is free text in SQLite, so `SUPERSEDED` is an enum addition only. Regenerations
are `MEDIA_REGENERATION` tasks whose `parentTaskId` is the production's task; the job payload carries `since`
so the edit plan is rebuilt for the new round. Asset metadata records `inspection` (format, bytes, sha256,
measured duration/size, method) and `providerAttempts` (fallback history).
