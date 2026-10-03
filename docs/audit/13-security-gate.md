# 13 — Security Gate

Evaluated at commit `eaf487c` (branch `claude/busy-pascal-h6hvhh`), 2026-10-03.

| Gate | Criterion | Result | Basis |
|---|---|---|---|
| **A** | No known Critical vulnerabilities | **PASS** | No finding rated Critical. The highest are High (F-01, F-02) |
| **B** | No exploitable High vulnerabilities in internet-facing / API surfaces | **FAIL** | F-01: the API is unauthenticated by default and accepts any `Host`. It is reachable by local processes and, via DNS rebinding, by a web page the owner visits. It exposes approval, visual-identity versioning and memory writes (RT-05b, RT-06) |
| **C** | No autonomous publishing bypass | **CONDITIONAL PASS** | No publishing code, tool, route, state or event exists (grep; RT-18, RT-20); `autonomousPublishingAllowed` is constant `false`. *Condition:* the approval control is forgeable by any API caller (F-01/F-04) and by DB edits (F-09). It must be authenticated before any publishing code is added |
| **D** | No agent privilege escalation | **CONDITIONAL PASS** | ToolKit allow-lists and levels are enforced; a LEVEL_5 claim is capped; models cannot select tools (RT-03, RT-04, RT-20). *Conditions:* over-broad `production.write` (F-10); enforcement is cooperative and in-process (F-19) |
| **E** | No arbitrary command execution from model- or user-controlled data | **PASS** | A single `spawn` with `shell:false`; argv is built from numbers and validated paths; text goes via stdin or SRT (RT-07). Config-defined binaries are an operator trust assumption (F-21) |
| **F** | No arbitrary filesystem escape | **CONDITIONAL PASS** | Traversal, absolute and null-byte paths are rejected (RT-08). *Condition:* symlinks inside `data/references` or `data/media` escape confinement (RT-09, F-08); this needs local write access |
| **G** | No critical secret exposure | **PASS** | No secrets in the tree or the history of 21 commits (regex scan); no leakage through 5 endpoints, error bodies or `redactConfig` (RT-15). *Caveat:* dedicated scanners (Gitleaks/TruffleHog) were unavailable |
| **H** | No critical dependency vulnerabilities | **PASS** | Runtime: 0 vulnerabilities. Dev: 4 moderate (drizzle-kit → esbuild, GHSA-67mh-4wv8-2f99) |
| **I** | Memory poisoning adequately controlled | **FAIL** | Direct API poisoning is blocked (RT-02a), but goal text is laundered into **trusted** agent memory (RT-01) and untrusted items can take every memory slot (RT-02b) |
| **J** | Prompt injection cannot cross critical trust boundaries | **FAIL** | It cannot reach tools, approval, the core identity or publishing (RT-13, RT-18, RT-19, RT-20). It **does** cross the memory trust boundary (untrusted → trusted, RT-01), and it bypasses the deterministic identity/safety guard before media generation (RT-12) |
| **K** | Security events are auditable | **CONDITIONAL PASS** | Events, `agent_runs.tool_calls`, `model_runs`, correlation ids and redacted logs exist. *Conditions:* actors are self-asserted (F-04); events and state are not tamper-evident (RT-05c, RT-17a); auth failures and process executions are not audited (F-17) |
| **L** | Supply chain has minimum controls | **FAIL** | Lockfile integrity ✔ and 0 runtime vulnerabilities ✔, but there is no CI, no automated scanning, no protected default branch, no signed commits, no digest-pinned images, and no model/workflow provenance (F-07) |

## Summary

| PASS | CONDITIONAL PASS | FAIL |
|---|---|---|
| A, E, G, H | C, D, F, K | B, I, J, L |

**Overall gate verdict: FAIL.** Four gates fail outright. Jovi does not meet the minimum bar for unattended (autonomous) production operation. It is acceptable as a **developer-attended local prototype** only if the owner sets `JOVI_API_TOKEN`, keeps the API on loopback, and does not browse untrusted sites while it runs. Configuring a token does not fix the DNS-rebinding path completely: without Host validation, a token stops the attack only if it never reaches the browser.
