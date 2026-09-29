# Integrations

Adapters to external systems live here, one folder per system. Agents never call these directly; they go through tools gated by `src/core/permissions`.

| Folder | Status (Phase 6) | Purpose |
|---|---|---|
| `ollama/` | **Implemented** | HTTP client for the local Ollama API (model detection, chat). Used by `OllamaProvider`. |
| `n8n/` | Planned | Outbound webhooks to n8n for external automation. n8n is *not* the brain: it executes, Jovi Core decides. Requires `LEVEL_4_EXTERNAL_ACTION`. |
| `comfyui/` | Planned | Image/video generation workflows for the Visual agent. |
| `flow/` | Planned | Video generation (Flow) for the Visual agent. |
| `social/` | Planned | Platform APIs (Instagram etc.). Publishing requires `LEVEL_4_EXTERNAL_ACTION` and human approval. |
| `storage/` | Planned | Media/asset storage. |

Planned integrations are intentionally not stubbed with code yet: Phase 6 is a controlled brain with no external actions.
