# Security Re-audit (v2) — 2026-10-03, commit `3318a43`

Start with `SECURITY_REAUDIT_FINAL.md`, then `06-remediation-status.md` for the state after remediation R2.

| File | Content |
|---|---|
| `SECURITY_REAUDIT_FINAL.md` | Verdict, posture, gate, CSO answer, independence disclosure |
| `01-findings.md` | New findings N-01 … N-12, with evidence and remediation |
| `02-historical-findings-status.md` | F-01 … F-24 and D-items re-verified |
| `03-red-team-results.md` | Original harness (27/27 HELD) and new probes (5 VULNERABLE) |
| `04-supply-chain-and-repository.md` | Dependencies, CI, repository settings, Dependabot PRs |
| `05-remediation-roadmap.md` | R2-01 … R2-09 |
| `06-remediation-status.md` | What R2 fixed, held-out recall (RA-11), residuals, owner steps |
| `redteam-results.json` | Output of `npx tsx docs/audit/poc/redteam.mts` |
| `reaudit-probe-results.json` | Output of `npx tsx docs/audit/poc/reaudit-probes.mts --write` at `3318a43` |
| `reaudit-probe-results-after-r2.json` | The same probes plus RA-11, after R2 |
| `redteam-results-after-r2.json` | Original harness after R2 (27/27 HELD) |
| `sbom-runtime.cdx.json` | `npm sbom --omit=dev --sbom-format=cyclonedx` |

The gate table of record is `docs/audit/13-security-gate.md`, updated by this re-audit. The first audit (`SECURITY_AUDIT_FINAL.md`, `01`–`13`) and the remediation status documents (`14`–`16`) are kept unchanged as history, apart from superseded notes.
