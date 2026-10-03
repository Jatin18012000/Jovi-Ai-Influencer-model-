# 07 — API Security Assessment

The target is `apps/api/server.ts` (Fastify 5.12.5) at commit `eaf487c`. Tests ran in-process (`app.inject`) and against a real `127.0.0.1` listener (RT-06).

## 1. Authentication and network exposure (section 25 of the brief)

| Aspect | Observed | Evidence |
|---|---|---|
| Mechanism | One static bearer token (`JOVI_API_TOKEN`) checked in an `onRequest` hook with `timingSafeEqual` | `server.ts:72-82` |
| **Default** | **No token**: `.env.example` ships `JOVI_API_TOKEN=` empty, and a loopback bind needs none | `.env.example:101`, `security.ts:17` |
| Non-loopback bind | Refused without a token unless `JOVI_ALLOW_UNAUTHENTICATED_NETWORK=true` | `security.ts:16-28` |
| Host / Origin validation | **None.** A spoofed Host is accepted, so a DNS-rebinding page in the owner's browser can drive every route | RT-06 (200 with `Host: rebind.attacker.example`) |
| Exempt route | `/health` is unauthenticated even when a token is set | `server.ts:75` |
| Sessions / cookies | None (stateless bearer). CSRF via cookies is not applicable | — |
| Classic CSRF | Blocked incidentally: only `application/json` is parsed (`text/plain` → 400), and a JSON POST from another origin needs a preflight, which gets 404 because there is no CORS plugin | RT-06 |
| CORS | Not configured, so no cross-origin reads | RT-06 |
| Token entropy / rotation / expiry | Not enforced: any non-empty string is accepted; no rotation, scopes or expiry | `config.ts:10-13,83` (F-14) |
| CLI authentication | None (relies on OS account) | `apps/orchestrator/cli.ts` |
| Docker exposure | Compose publishes `127.0.0.1:3000` with `JOVI_ALLOW_UNAUTHENTICATED_NETWORK=true`, so any container on the compose network reaches the API unauthenticated | `docker-compose.yml:22-26` (F-15) |
| Local-network attacker | **No access** with defaults (loopback bind). **Full access** if the operator binds `0.0.0.0` with a token and the token leaks, or via DNS rebinding through the owner's browser | — |

## 2. Authorization model

- **Function-level:** none. One credential, or none, grants every function: read, production, **human approval**, **visual identity versioning**, memory writes and evaluation (RT-05d, F-04).
- **Object-level (BOLA/IDOR):** single-tenant. Every authenticated caller can read every production, task, job, decision and event by id, and ids are random UUIDs. This is not applicable to a single-user deployment; **FAIL** for the planned n8n integration and any multi-user use.
- **Approval identity:** `reviewer` / `approvedBy` / `requestedBy` are free-text fields (`production-service.ts:53`). They are **not bound** to an authenticated principal, so there is no non-repudiation.

## 3. Per-route assessment

Legend: **Auth** = token hook (off by default); **RL** = `ExpensiveCallLimiter` (10 per minute per IP, 2 concurrent); **Val** = Zod input validation.

| Route | Auth | AuthZ (function) | Val | RL | Size / timeout | Sensitive data | Notes / findings |
|---|---|---|---|---|---|---|---|
| GET `/health` | **never** | — | — | — | — | provider states, LM Studio URL and models, media provider reasons | F-12 information disclosure |
| GET `/api/jovi/identity`, `/strategy` | opt. | none | — | — | — | identity and strategy (non-secret) | — |
| POST `/api/jovi/goal` | opt. | none | ✔ (`GoalRequestSchema`, goal ≤ 2000) | ✔ | 256 KiB; **no request timeout** | — | Injection persists into trusted memory (F-03) |
| POST `/api/jovi/planning` | opt. | none | ✔ | ✔ | sync only | — | Long synchronous request |
| POST `/api/productions` | opt. | none | ✔ (exactly one source) | ✔ sync, **✗ async concurrency** | — | — | F-05: async jobs queue without bound |
| GET `/api/productions/:id[/…]` | opt. | none | ✔ id ≤ 100 | — | — | artifacts and assets (local paths in `location`) | Discloses absolute local file paths (low) |
| POST `/api/productions/:id/decision` | opt. | **none (human function!)** | ✔ (`HumanDecisionSchema`) | **✗** | — | — | **F-01/F-04**: forgeable approval (RT-05b); replay → 409 |
| POST `/api/productions/:id/regenerate-media` | opt. | none | ✔ | ✔ | — | — | Unlimited regenerations per production (disk) |
| GET `/api/media/providers` | opt. | none | — | — | probes providers on every call | provider reasons | Probe amplification: each call spawns ffmpeg/say version checks (cached 30–60 s) |
| GET / POST `/api/visual-identity` | opt. | **none (human function!)** | ✔ (age ≥ 21, virtual) | **✗** | — | — | **F-01**: unauthenticated identity versioning by default; F-11 likeness |
| GET `/api/tasks/:id`, `/jobs/:id`, `/decisions/:id`, `/jovi/goal/:id` | opt. | none | ✔ | — | — | task inputs (goals) | — |
| GET `/api/events` | opt. | none | ✔ (type enum, limit ≤ 1000) | — | — | full event payloads (reviewer names, errors) | — |
| POST `/api/memory` | opt. | none | ✔ (typed, ≤ 4 KB value, key regex) | **✗** | — | — | F-05/F-06 flooding (300 writes accepted) |
| GET `/api/memory` | opt. | none | ✔ | — | — | all memory incl. identity seed | — |
| GET `/api/models`, `/api/agents` | opt. | none | — | — | `refresh=true` forces provider probes | model inventory | — |
| POST `/api/evaluate` | opt. | none | ✔ | ✔ | — | — | — |

Mass assignment: none. Every body is parsed through an explicit Zod schema, and only the parsed fields are used (`createdBy` is overwritten to `'api'`).

## 4. OWASP API Security Top 10 (2023)

| ID | Risk | Status | Evidence |
|---|---|---|---|
| API1 | Broken Object Level Authorization | **N/A for a single user / FAIL for multi-principal** | No ownership model. UUID ids make guessing impractical, but every holder reads all |
| API2 | Broken Authentication | **FAIL** | Auth is off by default; no Host validation; static token without policy (F-01, F-14) |
| API3 | Broken Object Property Level Authorization | PASS | Zod schemas whitelist fields; responses contain no secrets (RT-15) |
| API4 | Unrestricted Resource Consumption | **FAIL** | Async bypass of the concurrency cap; unthrottled memory/decision/visual-identity; no request timeout; no media disk quota (RT-14, F-05). Body limit 256 KiB ✔ |
| API5 | Broken Function Level Authorization | **FAIL** | Approval and identity changes need the same (or no) credential as reads (RT-05d, F-04) |
| API6 | Unrestricted Access to Sensitive Business Flows | **FAIL** | The human-approval flow can be driven by any API client or automation (RT-05b) |
| API7 | Server-Side Request Forgery | PASS | No request- or model-controlled URLs (RT-10) |
| API8 | Security Misconfiguration | **PARTIAL** | Secure bind default ✔; but no token by default, no security headers, `/health` disclosure, compose flag (F-12, F-15) |
| API9 | Improper Inventory Management | PARTIAL | Routes documented in the README; no OpenAPI spec, no versioning (`/api/...` unversioned) |
| API10 | Unsafe Consumption of APIs | **PARTIAL** | Provider responses Zod-validated (LLM) and signature-verified (media) ✔; unbounded response bodies buffered into memory (F-16); `https://` media locations accepted without inspection |

## 5. ASVS-oriented checks specific to the API

| Area | Status | Evidence |
|---|---|---|
| Input validation | PASS | Zod on every body, query and param; enums for types; bounded strings and arrays |
| Output encoding | PASS (JSON only) | Fastify JSON serialisation; no HTML |
| Injection (SQL) | PASS | Drizzle and bound `@params` (RT-16) |
| Error handling | **PARTIAL** | Typed errors map to 400/404/409/429/403. **500 responses return `error.message`** for `JoviError` and unknown errors (`server.ts:96,99`), which can disclose internal detail (F-13). Stack traces are not returned |
| Security headers | **FAIL** | None set (no `X-Content-Type-Options`, CSP, HSTS, `Referrer-Policy`, `X-Frame-Options`) (RT-06, F-12) |
| Rate limiting | PARTIAL | See API4 |
| Logging | PARTIAL | Fastify request logs include status codes (401s appear only as generic request logs); there is no security event for auth failures (F-17); the `authorization` header is redacted |
| TLS | N/A locally / FAIL if exposed | The API serves plain HTTP; any non-loopback deployment needs a TLS reverse proxy (not provided) |
| Request size | PASS | `bodyLimit` 256 KiB → 413 (RT-06) |
| Timeouts | **FAIL** | No `requestTimeout` / `connectionTimeout`; a sync production holds the connection for the whole pipeline |

## 6. Resource exhaustion on the 24 GB M-series Mac

- **Model inference:** at most 2 sync requests plus the worker (one job at a time) hit LM Studio at once. But the **async queue is unbounded**: 10 requests per minute → 600 queued productions per hour, each ~18 minutes of local inference (≈ 180 machine-hours queued per hour of abuse). LM Studio's own memory is not affected by Jovi; the effect is starvation.
- **Disk:** each real render is ~23 MB (Phase 9 run); unlimited regenerations at 10 per minute → ~14 GB per hour. There are no quotas and no garbage collection of SUPERSEDED assets.
- **Database:** memory writes are unthrottled (≤ 4 KB each); events, agent runs and model runs have no retention.
- **Cloud cost:** with a cloud key configured, NORMAL/HIGH-tier generation can go to cloud. There is no spend cap; costs are only *estimated* and recorded.
