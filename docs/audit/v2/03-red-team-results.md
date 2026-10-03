# 03 — Red-team Results (re-audit)

Two harnesses were run on commit `3318a43`, locally only: in-memory or temp-dir databases, loopback, test doubles, nothing external, nothing destructive.

## A. Original harness: `docs/audit/poc/redteam.mts` (27 checks)

Output: `redteam-results.json` (this folder). **27 HELD / 0 VULNERABLE / 0 PARTIAL.**

| Run | HELD | VULNERABLE | PARTIAL |
|---|---|---|---|
| Original audit (`eaf487c`) | 14 | 10 | 2 |
| After P0 | 20 | 6 | 1 |
| After P1 | 24 | 2 | 1 |
| After P2 | 27 | 0 | 0 |
| **Re-audit (`3318a43`)** | **27** | **0** | **0** |

These checks were written for the original findings, and every one still holds. They say nothing about attacks they don't contain, so harness B was written for this re-audit.

## B. New probes: `docs/audit/poc/reaudit-probes.mts` (10 probes)

Output: `reaudit-probe-results.json`. **3 HELD / 5 VULNERABLE / 2 INFO.**

| Probe | Target | Result | Key evidence | Finding |
|---|---|---|---|---|
| RA-01 | Safety-gate coverage of model-authored negative prompts | **VULNERABLE** | Verdict ALLOW; 3 image requests with "adult, mature woman, …" as negatives | N-01 (High) |
| RA-02 | Visual-identity likeness by name; lock excluded from review | **VULNERABLE** | 3/3 named-person anchors accepted; name present in image prompts | N-02 |
| RA-03 | Audit-log prefix deletion with a forged checkpoint | **VULNERABLE** | 10 events deleted; `verifyChain ok: true`; head unchanged | N-03 |
| RA-04 | 12 fresh paraphrases outside the corpus | **VULNERABLE** | 11 missed | N-04 |
| RA-05 | Tokens in logs (debug level) | HELD | Neither valid nor invalid tokens logged | — |
| RA-06 | DB/WAL/SHM permissions | HELD | All `600` | — |
| RA-07 | HTTP/1.0 without Host; 300 guessed tokens; expired/revoked | HELD | 403; 300×401 with 20 audit events (throttled); expired 401; revoked 401 | — |
| RA-08 | Budget with unpriced cloud calls | **VULNERABLE** | 500 unpriced runs → $0, budget not exhausted | N-05 |
| RA-09 | Origin port; path disclosure | INFO | `localhost:9999` → 200 with token; absolute asset paths | N-08, N-09 |
| RA-10 | In-process capability theft | INFO | Emitted (expected under F-19) | N-10 |

**Auditor note on RA-07.** The first version of this probe built its raw HTTP/1.0 request with `require()` inside an ES module, which threw. The "missing Host" sub-check therefore reported HELD without testing anything. This was caught, the probe was fixed (`node:net` import), and the re-run returns a genuine `HTTP/1.1 403 Forbidden`.

## Not testable here

- **The real-model safety review** (no LM Studio reachable). This is what decides whether RA-04-style phrasing is stopped in practice.
- **Real ComfyUI** and how negative prompts behave in a real diffusion model (RA-01 shows that the text is sent, not what the model does with it).
- **Browser-side DNS rebinding end to end.**
- **GitHub repository settings** beyond what the API exposes to this session. Branch protection read access was denied (403); `rulesets` returned `[]`; the branches API reports `protected=false` for every branch.
