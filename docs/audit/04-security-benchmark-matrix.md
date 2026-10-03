# 04 — Security Benchmark Matrix

**Rule applied:** a control is **PASS** only with CODE + ENFORCEMENT + TEST + EVIDENCE. If any of the four is missing, it is **PARTIAL** or **UNKNOWN**. Statuses: PASS / PARTIAL / FAIL / NOT_APPLICABLE / NOT_TESTABLE / UNKNOWN.

Severity refers to the gap, not the control. "RT-xx" points to `10-red-team-results.md`; "F-xx" to the findings register in `SECURITY_AUDIT_FINAL.md`. Framework item labels follow the published names; verify exact identifiers against the current release of each framework (ASVS 5.0 chapter names, ATLAS technique ids).

## A. OWASP ASVS 5.0

| Framework | Requirement / Control | Applicable? | Implementation Evidence | Test Evidence | Status | Gap | Severity | Recommended Remediation | File/Line |
|---|---|---|---|---|---|---|---|---|---|
| ASVS | Encoding & Sanitization (prompt data escaping) | Yes | `escapeData` turns `<>` into `‹›` inside data tags | RT-13; context tests | PASS | Recent decisions are rendered outside data tags | Low | Wrap every retrieved or derived text in tagged data blocks | `context-engine.ts:205-212,235` |
| ASVS | Validation & Business Logic (input schemas) | Yes | Zod on every route, agent input and model output | API tests; RT-16 | PASS | — | — | — | `server.ts:19-50` |
| ASVS | Business logic: state machines | Yes | Production and asset transition tables; human-only states | RT-05a; contract tests | PASS | Status is cast, not validated, on read (fails closed) | Info | Parse status with Zod | `production-service.ts:22-38` |
| ASVS | Web Frontend Security (headers, CSP) | Partial (JSON API) | None | RT-06 (no headers) | FAIL | No security headers | Low | Add `@fastify/helmet`-equivalent headers | `server.ts` |
| ASVS | API & Web Service (content types, CORS) | Yes | JSON-only parser; no CORS | RT-06 | PARTIAL | No Host/Origin allow-list | High | Validate `Host` and `Origin` against an allow-list | `server.ts:56-60` |
| ASVS | File Handling (paths, types, size) | Yes | Id/extension allow-lists; signature verification | RT-08, RT-09; media tests | PARTIAL | Symlinks followed; no size caps on provider output | Low | `realpath` + `lstat`; size limits | `media-store.ts:60-64` |
| ASVS | Authentication | Yes | Optional bearer token, timing-safe compare | `api.e2e` token test; RT-05d | **FAIL** | Off by default; no Host check; no token policy | High | Mandatory token (generated on first run) | `server.ts:72-82`, `security.ts:17` |
| ASVS | Session Management | N/A | Stateless bearer | — | NOT_APPLICABLE | — | — | — | — |
| ASVS | Authorization (function level) | Yes | None for humans or clients; ToolKit for agents | RT-05d | **FAIL** | One credential grants approval and identity changes | Medium | Separate scopes: read / operate / approve / identity-admin | `server.ts:200,237` |
| ASVS | Authorization (object level) | Single user | None | — | NOT_APPLICABLE (now) | Becomes FAIL with n8n or multiple users | Medium | Principal model before n8n | — |
| ASVS | Self-contained tokens / OAuth | N/A | — | — | NOT_APPLICABLE | — | — | — | — |
| ASVS | Cryptography | Limited | SHA-256 for asset integrity; `timingSafeEqual` | media tests | PASS (scope) | No signing of approvals or events | Low | HMAC-chain events and approvals | `media-inspector.ts` |
| ASVS | Secure Communication (TLS) | When exposed | HTTP only; cloud calls HTTPS by default | — | PARTIAL | Base URLs accept `http://`; no TLS for the API | Low | Require https for cloud base URLs; reverse proxy with TLS | `config.ts` |
| ASVS | Configuration (secure defaults) | Yes | Loopback bind; bind guard; ceiling LEVEL_3; mock isolation | `hardening` tests | PARTIAL | Unauthenticated default; compose flag | High | Secure-by-default token | `.env.example:101` |
| ASVS | Data Protection | Yes | Secrets redacted; data local | RT-15 | PARTIAL | Plaintext DB and media; no retention | Low | Retention and purge policy; FileVault guidance | `data/` |
| ASVS | Secure Coding & Architecture (no eval, parameterised SQL, no shell) | Yes | No eval or dynamic import; bound SQL; `spawn shell:false` | RT-07, RT-16 | PASS | — | — | — | `process-runner.ts:29` |
| ASVS | Dependency security | Yes | Lockfile + integrity; 0 runtime vulnerabilities | `npm audit` | PARTIAL | No automation; dev moderate vulnerabilities | Medium | CI with audit + OSV | `package-lock.json` |
| ASVS | Security Logging | Yes | Events, `agent_runs.tool_calls`, pino redaction | RT-15, RT-17a | PARTIAL | No auth-failure or process-exec audit; events forgeable | Low | Security audit stream; tamper evidence | `event-bus.ts` |
| ASVS | Error Handling | Yes | Typed error mapping | `api.e2e` | PARTIAL | 500 returns `error.message` | Low | Generic 500 body; log details server-side | `server.ts:96,99` |
| ASVS | Resource limits (DoS) | Yes | `bodyLimit` 256 KiB; limiter | RT-06, RT-14 | PARTIAL | Async bypass; no timeouts or quotas | Medium | Queue caps, timeouts, quotas | `server.ts:59,154` |
| ASVS | SSRF | Yes | Config-only URLs | RT-10 | PASS | — | — | — | `http.ts:24` |
| ASVS | Command injection | Yes | Argument arrays; stdin text | RT-07 | PASS | — | — | — | `ffmpeg-render-provider.ts:51-98` |
| ASVS | Deserialization | Yes | `JSON.parse` + Zod only | RT-13 | PASS | — | — | — | `models/json-output.ts` |

## B. OWASP API Security Top 10 (2023)

| Framework | Requirement / Control | Applicable? | Implementation Evidence | Test Evidence | Status | Gap | Severity | Recommended Remediation | File/Line |
|---|---|---|---|---|---|---|---|---|---|
| API2023 | API1 BOLA | Single user | No ownership | — | NOT_APPLICABLE (now) | FAIL once multi-principal | Medium | Ownership checks | — |
| API2023 | API2 Broken Authentication | Yes | Optional token | RT-05b, RT-06 | FAIL | Default off; DNS rebinding | High | F-01 fix | `server.ts:72` |
| API2023 | API3 BOPLA | Yes | Zod whitelists; redaction | RT-15 | PASS | — | — | — | — |
| API2023 | API4 Resource Consumption | Yes | Limiter, body limit | RT-14 | FAIL | Async queue; unthrottled routes | Medium | F-05 fix | `server.ts:154` |
| API2023 | API5 BFLA | Yes | none | RT-05d | FAIL | Single scope | Medium | Scopes | `server.ts:200,237` |
| API2023 | API6 Sensitive Business Flows | Yes | Human gate in code | RT-05b | FAIL | Approval drivable by any client | High | Authenticated reviewer + second factor | `production-service.ts:166` |
| API2023 | API7 SSRF | Yes | Config URLs | RT-10 | PASS | — | — | — | — |
| API2023 | API8 Misconfiguration | Yes | Bind guard | RT-06 | PARTIAL | Headers, health, compose | Low | Hardening | `docker-compose.yml:22` |
| API2023 | API9 Inventory | Yes | README route table | — | PARTIAL | No OpenAPI / versioning | Low | OpenAPI spec | — |
| API2023 | API10 Unsafe consumption | Yes | Zod for LLM output; signature checks for media | media tests | PARTIAL | Unbounded bodies; https locations not inspected | Low | Stream with caps | `comfyui-client.ts:106` |

## C. OWASP Top 10 for LLM Applications (2025)

| Framework | Requirement / Control | Applicable? | Implementation Evidence | Test Evidence | Status | Gap | Severity | Recommended Remediation | File/Line |
|---|---|---|---|---|---|---|---|---|---|
| LLM2025 | LLM01 Prompt Injection | Yes | Data tags, escaping, constraints, Zod, no tool choice | RT-01, RT-13, RT-18 | PARTIAL | Persists into trusted memory; content steering | Medium | Provenance-aware memory; untrusted-derived labelling | `executive-agent.ts:193` |
| LLM2025 | LLM02 Sensitive Info Disclosure | Yes | No secrets in prompts; redaction | RT-15 | PASS | — | — | — | `logger.ts` |
| LLM2025 | LLM03 Supply Chain | Yes | No auto-download; lockfile | static | PARTIAL | No model or workflow pinning; no CI | Medium | Model/workflow allow-list + hashes | — |
| LLM2025 | LLM04 Data & Model Poisoning (memory) | Yes | M1 controls | RT-02a/b, RT-01 | FAIL | Laundering + flooding | Medium | F-03, F-06 fixes | `context-engine.ts:107` |
| LLM2025 | LLM05 Improper Output Handling | Yes | Zod + identity guard + QA | RT-12 | PARTIAL | Regex guard bypass | High | Classifier/model-graded guard + allow-list anchors | `identity-guard.ts` |
| LLM2025 | LLM06 Excessive Agency | Yes | Models cannot call tools; LEVEL_3 ceiling; no publish | RT-04, RT-18, RT-20 | PASS | — | — | — | `toolkit.ts` |
| LLM2025 | LLM07 System Prompt Leakage | Yes | Prompts are public; no secrets inside | code review | PASS | — | — | — | `prompts/` |
| LLM2025 | LLM08 Vector & Embedding Weaknesses | No vectors | Keyword semantic memory | — | NOT_APPLICABLE | — | — | Re-assess when embeddings land | `semantic-memory.ts:33` |
| LLM2025 | LLM09 Misinformation | Yes | `sourceType` excludes live web | planning tests | PARTIAL | `freshness: CURRENT` without provenance | Medium | Require `evidence` + `verifiedAt` for CURRENT | `planning-agents.ts:30` |
| LLM2025 | LLM10 Unbounded Consumption | Yes | Limiter; timeouts | RT-14 | FAIL | Queue and cost unbounded | Medium | Budgets and queue caps | `server.ts:154` |

## D. OWASP Agentic AI (ASI01–ASI10)

| Framework | Requirement / Control | Applicable? | Implementation Evidence | Test Evidence | Status | Gap | Severity | Recommended Remediation | File/Line |
|---|---|---|---|---|---|---|---|---|---|
| ASI | ASI01 Goal Hijack | Yes | Tags, Zod, guard, QA | RT-01, RT-12, RT-13 | PARTIAL | Guard bypass; persistence | High | See F-02/F-03 | — |
| ASI | ASI02 Tool Misuse | Yes | ToolKit; no model tool choice | RT-03, RT-07 | PASS | Kind-unscoped production.write | Low | Scope by artifact kind | `toolkit.ts:140` |
| ASI | ASI03 Identity & Privilege Abuse | Yes | Ceiling; human-only states | RT-05b/d | FAIL | Human principal unauthenticated | High | F-01/F-04 | `server.ts:200` |
| ASI | ASI04 Supply Chain | Yes | Lockfile; no auto-download | static | PARTIAL | No CI or pinning | Medium | F-07 | — |
| ASI | ASI05 Unexpected Code Execution | Yes | `shell:false`; arg arrays | RT-07 | PASS | Config binaries trusted | Info | Hash-pin binaries | `process-runner.ts` |
| ASI | ASI06 Memory & Context Poisoning | Yes | M1 | RT-01, RT-02b | FAIL | Laundering, flooding | Medium | F-03/F-06 | — |
| ASI | ASI07 Inter-Agent Communication | Yes | Zod per hop; escaped | RT-13 | PASS | Events unauthenticated | Low | — | — |
| ASI | ASI08 Cascading Failures | Yes | Retries, fallback, recovery | RT-14, RT-17b | PARTIAL | Unbounded queue | Medium | Caps | — |
| ASI | ASI09 Human-Agent Trust Exploitation | Yes | NOT_VERIFIABLE never PASSED; ack required | contract tests | PARTIAL | False "identity.age PASSED" on paraphrase | Medium | Mark regex checks as heuristic | `qa-engine.ts` |
| ASI | ASI10 Rogue Agents | Yes | Allow-lists; ceiling | RT-04, RT-20 | PASS (scope) | No sandbox | Info | Process isolation if third-party agents arrive | — |

## E. MITRE ATLAS (techniques relevant to Jovi)

| Framework | Requirement / Control | Applicable? | Implementation Evidence | Test Evidence | Status | Gap | Severity | Recommended Remediation | File/Line |
|---|---|---|---|---|---|---|---|---|---|
| ATLAS | AML.T0051 LLM Prompt Injection | Yes | see LLM01 | RT-01, RT-13 | PARTIAL | persistence | Medium | F-03 | — |
| ATLAS | AML.T0054 LLM Jailbreak | Yes | guard + QA | RT-12 | PARTIAL | paraphrase bypass | High | F-02 | — |
| ATLAS | AML.T0070 RAG / memory poisoning (analogue) | Yes | M1 | RT-02 | PARTIAL | flooding | Medium | F-06 | — |
| ATLAS | AML.T0010 ML Supply Chain Compromise | Yes | no auto-download | static | PARTIAL | no pinning | Medium | F-07 | — |
| ATLAS | AML.T0029 Denial of ML Service / AML.T0034 Cost Harvesting | Yes | limiter | RT-14 | FAIL | queue / budget | Medium | F-05 | — |
| ATLAS | AML.T0048 External Harms (harmful generation) | Yes | guard, QA, human gate | RT-12 | PARTIAL | pre-approval generation | High | F-02 | — |
| ATLAS | AML.T0056 Meta-prompt extraction | Yes | prompts public | — | NOT_APPLICABLE | no secrets in prompts | — | — | — |

## F. NIST CSF 2.0

| Framework | Requirement / Control | Applicable? | Implementation Evidence | Test Evidence | Status | Gap | Severity | Recommended Remediation | File/Line |
|---|---|---|---|---|---|---|---|---|---|
| CSF | GV.RM / GV.PO (risk strategy, policy) | Yes | Phase docs, governance rules | — | PARTIAL | No security policy or risk register | Medium | Adopt this audit as a risk register | `docs/` |
| CSF | GV.SC (supply-chain risk) | Yes | Lockfile | — | PARTIAL | No supplier inventory or monitoring | Medium | F-07 | — |
| CSF | ID.AM (asset inventory) | Yes | This audit's inventory; SBOM | — | PARTIAL | Not maintained automatically | Low | SBOM in CI | `docs/audit/02` |
| CSF | ID.RA (risk assessment) | Yes | This audit | — | PARTIAL | First formal assessment | — | Repeat per phase | — |
| CSF | PR.AA (identity, authentication, access control) | Yes | Agent ToolKit; optional API token | RT-03, RT-05 | FAIL | Human/API authentication | High | F-01/F-04 | — |
| CSF | PR.DS (data security) | Yes | Redaction | RT-15 | PARTIAL | Plaintext; no backups | Low | F-23 | — |
| CSF | PR.PS (platform security) | Yes | Non-root container | — | PARTIAL | Hardening gaps | Low | F-15 | — |
| CSF | PR.IR (resilience) | Yes | Job recovery | RT-17b | PARTIAL | Exhaustion | Medium | F-05 | — |
| CSF | DE.CM / DE.AE (monitoring) | Yes | Events, logs | — | PARTIAL | No alerting or security audit stream | Low | F-17 | — |
| CSF | RS / RC (respond, recover) | Yes | none | — | FAIL | No IR plan, backups or runbooks | Medium | IR runbook + backups | — |

## G. NIST AI RMF 1.0 and NIST AI 600-1

| Framework | Requirement / Control | Applicable? | Implementation Evidence | Test Evidence | Status | Gap | Severity | Recommended Remediation | File/Line |
|---|---|---|---|---|---|---|---|---|---|
| AI RMF | GOVERN (roles, human oversight) | Yes | Human gates in code | RT-05a | PARTIAL | Overseer unauthenticated | High | F-04 | — |
| AI RMF | MAP (context, impacts) | Yes | Identity / visual bibles | — | PARTIAL | No documented harm taxonomy for generation | Medium | Harm model for media | `knowledge/jovi` |
| AI RMF | MEASURE (testing, evaluation) | Yes | QA engine; deterministic tests; real LM Studio run | 227 tests | PARTIAL | No red-team regression suite in CI; regex guards | Medium | Commit this harness as tests after fixes | — |
| AI RMF | MANAGE (risk treatment) | Yes | Gates, ceilings | — | PARTIAL | No monitoring of model drift or outputs | Low | Output sampling review | — |
| AI 600-1 | Information Integrity / Confabulation | Yes | `sourceType`; no live-web claims | planning tests | PARTIAL | CURRENT trends lack provenance | Medium | D-20 | — |
| AI 600-1 | Obscene / Degrading / Abusive content (incl. minors) | Yes | EXPLICIT / MINOR regexes; character lock age 25; human gate | RT-12 | **FAIL** | Paraphrase bypass before generation | High | F-02 | `identity-guard.ts:12` |
| AI 600-1 | Human-AI Configuration | Yes | Human-only approval | RT-05 | PARTIAL | Unauthenticated human | High | F-04 | — |
| AI 600-1 | Information Security | Yes | see CSF | — | PARTIAL | F-01 | High | — | — |
| AI 600-1 | Intellectual Property / likeness | Yes | LIKENESS regex on prompts | contract tests | PARTIAL | Visual identity accepts likeness text | Low | F-11 | `visual-identity.ts` |
| AI 600-1 | Value chain & component integration | Yes | Provider contracts; no auto-download | — | PARTIAL | No model/workflow provenance | Medium | F-07/F-20 | — |

## H. NIST SP 800-218 SSDF 1.1

| Framework | Requirement / Control | Applicable? | Implementation Evidence | Test Evidence | Status | Gap | Severity | Recommended Remediation | File/Line |
|---|---|---|---|---|---|---|---|---|---|
| SSDF | PO.1 / PO.3 (security requirements, toolchains) | Yes | Phase specs embed security rules | — | PARTIAL | No security-requirements baseline document | Low | Adopt the ASVS L1/L2 subset | — |
| SSDF | PS.1 (protect code) | Yes | GitHub hosting | — | FAIL | No protected branch, no signing | Medium | F-07 | — |
| SSDF | PS.3 (archive / provenance) | Yes | none | — | FAIL | No releases, tags or attestations | Low | Tag phases; sign releases | — |
| SSDF | PW.4 (reuse secure components) | Yes | 5 runtime dependencies, 0 vulnerabilities | `npm audit` | PASS | — | — | — | `package.json` |
| SSDF | PW.7 (code review) | Yes | none enforced (AI-authored phases) | — | FAIL | No independent review | Medium | Required PR review | — |
| SSDF | PW.8 (test executable code) | Yes | 227 tests (local only) | vitest | PARTIAL | Not enforced by CI | Medium | CI | — |
| SSDF | RV.1 (identify vulnerabilities continuously) | Yes | none | — | FAIL | No scanning automation | Medium | Dependabot / OSV + secret scan | — |

## I. CIS Controls v8.1

| Framework | Requirement / Control | Applicable? | Implementation Evidence | Test Evidence | Status | Gap | Severity | Recommended Remediation | File/Line |
|---|---|---|---|---|---|---|---|---|---|
| CIS | 2 Software asset inventory | Yes | SBOM (manual) | — | PARTIAL | Not automated | Low | SBOM in CI | `docs/audit/sbom-runtime.cdx.json` |
| CIS | 3 Data protection | Yes | Redaction | RT-15 | PARTIAL | Plaintext at rest | Low | F-23 | — |
| CIS | 4 Secure configuration | Yes | Loopback bind; non-root container | RT-06 | PARTIAL | Default no-auth; headers | High | F-01 | — |
| CIS | 5 / 6 Account and access control | Yes | One static token | RT-05d | FAIL | No accounts or roles | Medium | F-04/F-14 | — |
| CIS | 7 Continuous vulnerability management | Yes | Ad hoc `npm audit` | — | FAIL | No cadence | Medium | F-07 | — |
| CIS | 8 Audit log management | Yes | Events + logs | RT-17a | PARTIAL | Not tamper-evident | Low | F-09/F-17 | — |
| CIS | 11 Data recovery | Yes | none | — | FAIL | No backups | Medium | Backup `data/` | — |
| CIS | 16 Application software security | Yes | Zod, ToolKit, tests | many | PARTIAL | No CI or review gate | Medium | F-07 | — |
| CIS | 17 Incident response | Yes | none | — | FAIL | No IR plan | Medium | Runbook | — |
| CIS | 18 Penetration testing | Yes | This audit | RT-01..20 | PARTIAL | First iteration | — | Repeat before Phase 10 | — |

## J. CVSS v4.0 / OWASP AIVSS, SBOM practices, CISA Secure by Design, OSV, GitHub practices

| Framework | Requirement / Control | Applicable? | Implementation Evidence | Test Evidence | Status | Gap | Severity | Recommended Remediation | File/Line |
|---|---|---|---|---|---|---|---|---|---|
| CVSS v4.0 | Severity vectors for confirmed findings | Yes | Vectors in the findings register | — | PARTIAL | Scores estimated without the FIRST calculator | — | Confirm with the FIRST v4 calculator | `SECURITY_AUDIT_FINAL.md` |
| OWASP AIVSS | Agentic risk scoring | Yes | Qualitative AIVSS factors per finding | — | PARTIAL | Framework still in draft; qualitative only | — | Re-score when AIVSS stabilises | — |
| CycloneDX | SBOM | Yes | `npm sbom` CycloneDX 1.5 | — | PARTIAL | One-off, runtime only | Low | Generate in CI per release | `docs/audit/sbom-runtime.cdx.json` |
| CISA SbD | Secure by default | Yes | Loopback, ceiling, mock isolation | RT-04/06 | PARTIAL | Auth off by default | High | Token on by default | `.env.example:101` |
| CISA SbD | Eliminate vulnerability classes (SQLi, command injection) | Yes | ORM / bound params; `shell:false` | RT-07, RT-16 | PASS | — | — | — | — |
| OSV | Known-vulnerability lookup | Yes | `npm audit` (GHSA) as substitute | — | PARTIAL | osv-scanner unavailable | Low | Add osv-scanner to CI | — |
| GitHub | Branch protection, secret scanning, Dependabot | Yes | none | — | FAIL | All absent | Medium | Enable on the repository | — |

## Roll-up

| Framework | Rows | PASS | PARTIAL | FAIL | NOT_APPLICABLE |
|---|---|---|---|---|---|
| ASVS 5.0 | 23 | 8 | 9 | 3 | 3 |
| API Top 10 2023 | 10 | 2 | 3 | 4 | 1 |
| LLM Top 10 2025 | 10 | 3 | 4 | 2 | 1 |
| Agentic ASI01–10 | 10 | 4 | 4 | 2 | 0 |
| MITRE ATLAS | 7 | 0 | 5 | 1 | 1 |
| NIST CSF 2.0 | 10 | 0 | 8 | 2 | 0 |
| NIST AI RMF / AI 600-1 | 10 | 0 | 9 | 1 | 0 |
| SSDF 1.1 | 7 | 1 | 2 | 4 | 0 |
| CIS v8.1 | 10 | 0 | 6 | 4 | 0 |
| CVSS / AIVSS / SBOM / CISA / OSV / GitHub | 7 | 1 | 5 | 1 | 0 |
| **Total** | **104** | **19** | **55** | **24** | **6** |

There are no CRITICAL gaps. The highest are **High**: authentication by default (F-01), the identity/safety guard bypass (F-02), and an unauthenticated human approver (F-04, rated Medium today and a blocker for Phase 10).
