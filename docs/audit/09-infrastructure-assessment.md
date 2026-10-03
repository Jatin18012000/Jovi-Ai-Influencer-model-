# 09 — Infrastructure, Container, CI/CD & Git Assessment

## 1. Docker (`docker/Dockerfile`)

| Control | Observed | Status |
|---|---|---|
| Multi-stage build; dev dependencies pruned | yes (`npm prune --omit=dev`) | PASS |
| Non-root runtime | `USER node`; `/app` chowned to `node` | PASS |
| Base image pinning | `node:22-bookworm-slim` **tag**, not digest | FAIL (low) |
| Build toolchain in runtime image | no (build stage only) | PASS |
| Healthcheck | `fetch /health` | PASS |
| Read-only root filesystem / `cap_drop` / `no-new-privileges` | not set | FAIL (low) |
| Secrets in image | none: `.env` is not copied; config comes from env | PASS |
| Media tooling | **No ffmpeg in the image**, so the Phase 9 render provider cannot work in the container (functional gap, documented nowhere) | DOC GAP |
| Image vulnerability scan | not possible (Trivy/Grype missing) | NOT_TESTABLE |

## 2. Compose (`docker-compose.yml`)

| Control | Observed | Status |
|---|---|---|
| Published port | `127.0.0.1:3000:3000` (loopback only) | PASS |
| Authentication | `JOVI_ALLOW_UNAUTHENTICATED_NETWORK: "true"` and no token by default, so **any container on the same compose network** (for example a future n8n or ComfyUI service) reaches the API without authentication | FAIL (F-15) |
| `env_file: .env` | the whole `.env` (all provider keys) is injected into the container | INFO |
| Host networking / privileged / docker.sock mount | none | PASS |
| Volumes | `./data:/app/data` (DB and media), read-write | INFO |
| Resource limits (CPU, memory, pids) | none | FAIL (low) |
| `extra_hosts host.docker.internal:host-gateway` | lets the container reach every host service (LM Studio, ComfyUI) | INFO |
| Restart policy | `unless-stopped` | — |

**Container escape amplification:** low. The process is not root, has no privileged mode and no socket mount. The main amplification is reach into host services via `host-gateway`.

## 3. Host (owner's Mac, 24 GB)

| Item | Assessment |
|---|---|
| LM Studio | Bound to `localhost:1234` by default. Jovi only calls it; if LM Studio's own server is set to "serve on local network", any LAN host can use the model (outside Jovi's control; check the LM Studio setting) |
| ComfyUI | No authentication by design; must stay on `127.0.0.1` (do not use `--listen 0.0.0.0`). Custom nodes execute arbitrary Python |
| Data at rest | `data/jovi.db` and `data/media` are plaintext; default umask permissions; no backup or retention policy (F-23) |
| Executables | `JOVI_FFMPEG_PATH`, `JOVI_FFPROBE_PATH` and `MACOS_SAY_PATH` from `.env` are executed. Write access to `.env` therefore means code execution (F-21) |

## 4. CI/CD (section 27)

There is **no CI/CD**: no `.github/workflows`, no other pipeline config. Consequences:
- no automated gate on tests, typecheck or audit
- no secret scanning on push
- no SBOM or provenance
- no protection against a malicious change landing on the only branch

The CI-specific risks (untrusted `pull_request_target`, unpinned actions, cache poisoning) are **not applicable today**. Lacking CI is itself a control **FAIL** (SSDF PW.8, RV.1; CIS 16).

## 5. Git (section 28)

| Item | Observed |
|---|---|
| Branches | one (`claude/busy-pascal-h6hvhh`); remote HEAD points to it; **no `main`** |
| Tags / releases | none |
| Force pushes | not detectable from a clone; reflog only shows local history |
| Secrets in history | none found (regex scan of all 21 commits; see 08) |
| Large binaries / generated media / env files | none committed (`.gitignore` covers `data/*`, `*.db`, `.env*`) |
| Suspicious commits | none. Two identities: the owner (Phase 7, committed via the web) and the Claude agent (Phases 6, 8, 9) |
| Workflow or dependency changes | dependency set stable; no workflow files exist |
| Commit signing | none |

## 6. Observability and incident readiness (sections 23–24)

| Security event | Logged / evented? | Evidence |
|---|---|---|
| Authentication failure | Generic Fastify request log with status 401 only; no event or counter | `server.ts:72-82` (F-17) |
| Authorization (tool) denial | **Yes**: `agent_runs.tool_calls` (`allowed:false`) and `AGENT_FAILED.deniedTools` | `agent-runner.ts:130-145` |
| Privilege / ceiling changes | Config only; logged at startup via `redactConfig` | `apps/api/main.ts:17-20` |
| Memory writes | Yes: MEMORY_CREATED/UPDATED with source | `operational-memory.ts` |
| Identity changes | Visual: VISUAL_IDENTITY_VERSION_CREATED (API/CLI). Core identity: no route | — |
| Model selection / fallback | Yes: MODEL_SELECTED / MODEL_FALLBACK, `model_runs` | router |
| Media provider fallback | Yes: MEDIA_PROVIDER_FALLBACK | `media-service.ts` |
| External API calls | `model_runs` (LLM); media assets record provider, job id and attempts | — |
| Command execution | **Not logged** (process runner has no logging) | `process-runner.ts` (F-17) |
| File access | Not logged | — |
| Approval decisions | Yes: PRODUCTION_APPROVED/REJECTED. **The actor is self-asserted** | F-04 |
| Publishing attempts | N/A (no publishing) | — |
| Secrets in logs | Pino redaction of `apiKey`, `token`, `authorization` (selected depths) + `redactConfig`; RT-15 clean | PASS |
| Prompt / PII leakage | Goals and outputs are stored in `agent_runs.input/output` and decisions (plaintext DB). Not logged to stdout | INFO (F-23) |
| Correlation ids | Present on events, tasks, jobs, agent runs and logs | PASS |
| Tamper evidence | **None**: events are mutable SQLite rows; any in-process code can emit any event (RT-17a, F-09) | FAIL |
| Error disclosure | 500s return `error.message` (F-13); no stack traces | PARTIAL |
| Alerting, runbooks, backups, IR plan | **None** | FAIL |
