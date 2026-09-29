# Integrations

Adapters to external systems live here, one folder per system. Agents never call these directly; they go through tools gated by `src/core/permissions`.

| Folder | Status (Phase 9) | Purpose |
|---|---|---|
| `lmstudio/` | **Implemented** | Client for LM Studio's local server — Jovi's only local-model runtime. Model discovery via native `/api/v1/models` (≥ 0.4), `/api/v0/models`, or OpenAI-compatible `/v1/models`; generation via `/v1/chat/completions`. Used by `LMStudioProvider`. Never downloads or loads models. |
| `n8n/` | Planned | Outbound webhooks to n8n for external automation. n8n is *not* the brain: it executes, Jovi Core decides. Requires `LEVEL_4_EXTERNAL_ACTION`. |
| `comfyui/` | **Implemented (fake-server tested; real run is a manual gate)** | Client for a ComfyUI server's HTTP API (`/system_stats`, `/prompt`, `/history/{id}`, `/view`, `/upload/image`). Used by `ComfyUIImageProvider` / `ComfyUIVideoProvider` in `src/media/providers`, which run an operator-supplied API-format workflow; `{{REFERENCE_IMAGE}}` / `{{SOURCE_IMAGE}}` placeholders enable identity conditioning and image-to-video. Never run against a real ComfyUI in this repository. |
| `flow/` | Not integrated | Google Flow has no executable API integration. `GoogleFlowVideoProvider` (`src/media/providers/unintegrated-providers.ts`) always reports `NOT_INTEGRATED` and refuses to generate. |
| `social/` | Planned | Platform APIs (Instagram etc.). Publishing requires `LEVEL_4_EXTERNAL_ACTION` and human approval. |
| `storage/` | Partial | Local media storage is `src/media/media-store.ts` (confined to `JOVI_MEDIA_DIR`). Cloud storage is planned. |
| voice | **Implemented (not validated for real)** | `src/media/providers/voice-providers.ts`: macOS `say` (LOCAL, `MACOS_SAY_VOICE`) and ElevenLabs (CLOUD, `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID`). Tested with a fake `say` binary and a fake ElevenLabs server only. |
| render | **Implemented; real ffmpeg E2E passed in the build container (Linux, ffmpeg 6.1.1)** | `src/media/providers/ffmpeg-render-provider.ts`: renders an edit plan to MP4 (h264/aac, soft subtitles) with a local ffmpeg (`JOVI_FFMPEG_PATH`). Not yet run on the owner's Mac. |

Planned integrations are intentionally not stubbed with fake behaviour. No integration publishes content: publishing stays a PLANNED, LEVEL_4, human-gated capability.
