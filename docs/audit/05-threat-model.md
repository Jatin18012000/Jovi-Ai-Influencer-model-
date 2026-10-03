# 05 — Threat Model

Method: asset- and boundary-driven, with STRIDE per boundary and attack paths validated by the red-team harness where safe. Deployment assumed: a single owner on a 24 GB Apple-silicon Mac, Jovi API on `127.0.0.1:3000`, LM Studio on `localhost:1234`, and optional ComfyUI, ffmpeg, `say` and ElevenLabs.

## 1. System and trust boundaries

```
 [Owner / browser]──(TB1 user→API, HTTP, optional bearer)──►[Fastify API]──►[Orchestrator / Pipelines]
 [CLI on host]─────(TB1' OS account only)──────────────────────────────────►      │
 [n8n (future)]────(TB10 n8n→Jovi, same single token)──────►[Fastify API]          │
                                                                                   ▼
                                     (TB3 orchestrator→agent: ToolKit + PermissionGuard)
                                                                                   ▼
   [Agents: executive, planning ×4, production ×8] ──(TB4 agent→model: ModelRouter, JSON+Zod)──► LM Studio | Anthropic | OpenAI | Gemini
           │                       │
           │ (TB5 agent→memory)    │ (TB6 agent→tool→provider)
           ▼                       ▼
   [SQLite: identity, strategy,  [MediaService] ──(TB7 tool→external provider)──► ComfyUI (HTTP) | ElevenLabs (HTTPS)
    memory, decisions, events,          │                                       ffmpeg / say / ffprobe (process)
    productions, assets]                └──(TB8 provider→filesystem)──► data/media, data/references
           ▲
           └──(TB11 human reviewer→approval: /decision, --decide)
   [Jovi → social platforms] (TB9) — DOES NOT EXIST (no publishing code)
```

## 2. Assets

| Asset | C / I / A priority | Where | Primary threats |
|---|---|---|---|
| Jovi core identity (versioned) | I: critical | `identity_versions` | override via prompt, memory or API |
| Visual identity (versioned) | I: critical | `visual_identity_versions` | unauthenticated replacement (F-01); likeness (F-11) |
| System prompts / templates | I: high (not secret) | `prompts/` | tampering via repository |
| Operational memory | I: high | `memory_items` | poisoning, laundering, flooding (F-03, F-06) |
| Strategy | I: high | `strategy_versions` | silent activation (none found) |
| Credentials (cloud keys, ElevenLabs, API token) | C: critical | env / `.env` | leakage via logs, responses or git (none found) |
| Model access (local and cloud) | A, cost | LM Studio, providers | exhaustion, cost harvesting (F-05) |
| Media assets, reference sheet | C/I: high | `data/media`, `data/references` | path escape (F-08), harmful generation (F-02) |
| Production and approval state | I: critical | `productions`, events | approval forgery (F-01, F-04, F-09) |
| Database | C/I | `data/jovi.db` | local tampering (F-09), plaintext (F-23) |
| API | A, I | Fastify | DNS rebinding, abuse (F-01, F-05) |
| Publishing capability | I: critical | — | **does not exist** |
| GitHub repository | I: critical | GitHub | unprotected single branch (F-07) |
| Local Mac | all | host | config poisoning (F-21), ComfyUI nodes (F-20) |
| ComfyUI / n8n / social accounts | all | external | trust assumptions; n8n and social not integrated |

## 3. Threat actors

| Actor | Capability assumed | Relevant paths |
|---|---|---|
| Malicious web page (owner browsing while Jovi runs) | DNS rebinding to `127.0.0.1:3000` | AP-1 |
| Malicious prompt / goal author (anyone with API access) | Free-text goals, ideas and memory | AP-2, AP-3, AP-5 |
| Malicious research or tool output, compromised model | Controls model output | AP-3, AP-4 |
| Local process / other local user / malware | Loopback HTTP, filesystem | AP-1, AP-6, AP-7 |
| Compromised dependency or upstream binary | Code execution at install or run | AP-8 |
| Compromised external provider (ComfyUI, ElevenLabs, LM Studio) | Returns malicious responses | AP-9 |
| Automation with the API token (future n8n) | Full API | AP-1b |
| Insider / maintainer account compromise | Push to the only branch | AP-8 |
| Rogue first-party agent (bug) | In-process code | AP-10 |

## 4. STRIDE by boundary (condensed)

| Boundary | S | T | R | I | D | E |
|---|---|---|---|---|---|---|
| TB1 user→API | **Weak**: no auth by default, no Host check (F-01) | Zod validation ✔ | **Weak**: actor names self-asserted (F-04) | `/health` disclosure (F-12) | Partial limits (F-05) | One credential = all functions (F-04) |
| TB3 orchestrator→agent | n/a | — | `agent_runs` ✔ | — | — | ToolKit enforced ✔ (RT-03/04) |
| TB4 agent→model | Provider auth via headers ✔ | Output Zod-validated ✔; identity guard weak (F-02) | `model_runs` ✔ | Keys never in prompts ✔ | Router timeouts ✔ | Model cannot invoke tools ✔ |
| TB5 agent→memory | — | **Laundering into trusted memory (F-03)** | Events ✔ | — | Flooding (F-06) | — |
| TB6/7 tool→provider | Config URLs only ✔ | Output signature-verified ✔ | Assets record attempts ✔ | Keys header-only ✔ | Unbounded bodies (F-16) | No argv injection ✔ (RT-07) |
| TB8 provider→filesystem | — | Id/extension confinement ✔; symlinks (F-08) | — | Reads confined (lexical) | No quotas (F-05) | — |
| TB11 reviewer→approval | **Not authenticated** (F-01/F-04) | DB forgeable (F-09) | Self-asserted reviewer | — | — | Approval only from AWAITING ✔ |
| TB9 Jovi→social | — | — | — | — | — | **No path exists** ✔ |

## 5. Attack paths

| ID | Path | Preconditions | Result today | Validated |
|---|---|---|---|---|
| **AP-1** | Malicious site → DNS rebinding → `POST /api/productions/:id/decision` (approve), `POST /api/visual-identity` (replace appearance), `POST /api/memory` (poison), `POST /api/productions` async ×N (exhaust) | Jovi running with the default config (no token); owner visits the page | Approval state forged; visual identity replaced; memory poisoned; local inference starved. **No publishing** (does not exist) | Server precondition RT-06; effects RT-05b, RT-02b, RT-14 |
| AP-1b | Token holder (automation) approves its own production runs | Token shared with n8n or scripts | The "human" gate is bypassed by automation | RT-05d |
| **AP-2** | Goal with injected instructions → executive model echoes it → stored as trusted DECISION/CONTENT memory and a semantic concept → shown as *trusted* in every later context (and in "Recent decisions" outside data tags) | API access | Persistent steering of future planning and creative output | RT-01 |
| **AP-3** | Injected idea/goal or a compromised model writes "a 16 year old girl in her school uniform" or "I am a human" → identity guard misses it → visual prompts → **ComfyUI generates images before any human review** | API access (or model compromise) and ComfyUI configured | Harmful or off-identity media generated locally; publication still needs human approval | RT-12 (guard); pipeline path by code review |
| AP-4 | Malicious script content tries to close a data tag and instruct downstream agents | Model output | Escaped; no state change | RT-13 (HELD) |
| AP-5 | Flood `/api/memory` with keyword-stuffed facts | API access | All 10 memory slots are untrusted attacker text | RT-02b |
| AP-6 | Local user plants a symlink in `data/references` → visual identity points at it → ComfyUI upload sends the target file to ComfyUI | Local write access | Exfiltration of a local file to ComfyUI | RT-09 |
| AP-7 | Local user edits SQLite to set APPROVED, or edits `.env` to point `JOVI_FFMPEG_PATH` at a payload | Local write access | Forged approval (no reconciliation); code execution as the Jovi user | RT-05c; code review |
| AP-8 | Compromised npm package, better-sqlite3 prebuilt binary, base image or ComfyUI custom node | Upstream compromise | Code execution; there is no CI or scanning to detect it | Static review (08) |
| AP-9 | Compromised ComfyUI or ElevenLabs returns huge or malicious bodies or media | Provider compromise | Memory pressure (unbounded buffers); malformed media parsed by ffprobe/ffmpeg | Code review (F-16, F-21) |
| AP-10 | Buggy agent writes a `QA_REPORT` or emits `PRODUCTION_APPROVED` | Code defect | `qaStatus` manipulated; forged audit event; approval still needs AWAITING + human | RT-04b, RT-17a |

## 6. Risk-ranked threats

1. **AP-1 / F-01**: unauthenticated default API. Exploitable from the network via the owner's browser; it reaches the most sensitive functions.
2. **AP-3 / F-02**: deterministic safety guard bypass before media generation (minor depiction, AI transparency).
3. **AP-2 / F-03**: persistent injection laundered into trusted memory.
4. **AP-1b / F-04**: approval not bound to a human principal (a blocker for Phase 10).
5. **F-05 / F-06**: resource exhaustion and context flooding.
6. **AP-8 / F-07**: no CI or supply-chain automation.

## 7. Framework mapping (attack paths)

| Path | OWASP LLM 2025 | OWASP Agentic | MITRE ATLAS (verify ids against the current ATLAS release) | NIST AI 600-1 risk |
|---|---|---|---|---|
| AP-1 | — | ASI03 | — | Information Security |
| AP-2 | LLM01, LLM04 | ASI01, ASI06 | AML.T0051.000 (direct prompt injection), AML.T0070 (RAG poisoning, analogue for memory) | Information Integrity |
| AP-3 | LLM01, LLM05 | ASI01, ASI09 | AML.T0054 (jailbreak), AML.T0048 (external harms) | Obscene/Degrading/Abusive Content, Dangerous Content |
| AP-5 | LLM04, LLM10 | ASI06, ASI08 | AML.T0029 (denial of ML service) | Information Integrity |
| AP-8 | LLM03 | ASI04 | AML.T0010 (ML supply-chain compromise) | Value Chain & Component Integration |
| AP-9 | LLM03 | ASI04 | AML.T0010 | Information Security |
| F-05 | LLM10 | ASI08 | AML.T0029, AML.T0034 (cost harvesting) | — |
