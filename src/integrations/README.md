# Integrations

Adapters to external systems live here, one folder per system. Agents never call these directly; they go through tools gated by `src/core/permissions`.

| Folder | Status (Phase 8) | Purpose |
|---|---|---|
| `lmstudio/` | **Implemented** | Client for LM Studio's local server — Jovi's only local-model runtime. Model discovery via native `/api/v1/models` (≥ 0.4), `/api/v0/models`, or OpenAI-compatible `/v1/models`; generation via `/v1/chat/completions`. Used by `LMStudioProvider`. Never downloads or loads models. |
| `n8n/` | Planned | Outbound webhooks to n8n for external automation. n8n is *not* the brain: it executes, Jovi Core decides. Requires `LEVEL_4_EXTERNAL_ACTION`. |
| `comfyui/` | **Implemented (not externally validated)** | Client for a ComfyUI server's HTTP API (`/system_stats`, `/prompt`, `/history/{id}`, `/view`). Used by `ComfyUIImageProvider` / `ComfyUIVideoProvider` in `src/media/providers`, which run an operator-supplied API-format workflow. Tested only against a fake ComfyUI HTTP server; never run against a real ComfyUI in this repository. |
| `flow/` | Not integrated | Google Flow has no executable API integration. `GoogleFlowVideoProvider` (`src/media/providers/unintegrated-providers.ts`) always reports `NOT_INTEGRATED` and refuses to generate. |
| `social/` | Planned | Platform APIs (Instagram etc.). Publishing requires `LEVEL_4_EXTERNAL_ACTION` and human approval. |
| `storage/` | Partial | Local media storage is `src/media/media-store.ts` (confined to `JOVI_MEDIA_DIR`). Cloud storage is planned. |
| voice / editing | Not integrated | No speech-synthesis or render engine exists yet. The provider interfaces are in `src/media/types.ts`; with none registered, voice and render assets are `BLOCKED`. |

Planned integrations are intentionally not stubbed with fake behaviour. No integration publishes content: publishing stays a PLANNED, LEVEL_4, human-gated capability.
