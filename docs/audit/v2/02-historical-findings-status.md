# 02 — Status of the Original Findings (F-01 … F-24, D-items)

Every original finding was re-verified at `3318a43`. A remediation document saying something was fixed was not taken as evidence; each status rests on the harness check, test or probe in the Evidence column.

| ID | Orig. | Title | Status now | Evidence |
|---|---|---|---|---|
| F-01 | High | Unauthenticated API, no Host/Origin validation | **Resolved** | RT-05b, RT-06 (raw socket), RA-07 (HTTP/1.0 without Host → 403; 300 guessed tokens → 401) |
| F-02 | High | Guard bypass (incl. minors) before media generation | **Partially resolved** | Gate exists and holds for idea/script/prompt text (RT-12b). **Residual:** N-01 (negative prompts unreviewed, High) and N-04 (heuristics miss fresh paraphrases; model review unvalidated) |
| F-03 | Medium | Goal text laundered into trusted memory | **Resolved** | RT-01 |
| F-04 | Medium | Approval not bound to an authenticated human | **Resolved** (residual) | RT-05d. Residual: no second factor for API approvals (needed before Phase 10) |
| F-05 | Medium | Resource exhaustion | **Resolved** (residual) | RT-14. Residual: N-05 (unpriced cloud spend) |
| F-06 | Medium | Context flooding | **Resolved** | RT-02b |
| F-07 | Medium | No secure SDLC | **Partially resolved** | CI (4 jobs, green), pinned actions, scanners, SBOM, Dependabot, digest-pinned image. **Open:** no protected branch, no rulesets (verified via the API), the default branch is the working branch, and the repository is **public**. See `04-supply-chain-and-repository.md` |
| F-08 | Low | Symlink escape | **Resolved** (residual) | RT-09 (file, directory, read-through). Residual: N-06 (TOCTOU) |
| F-09 | Low | Approval/events not tamper-evident | **Resolved** (residual) | RT-05c, RT-17a. Residual: N-03 (forged checkpoint) and tail re-hash by a database writer |
| F-10 | Low | Confused deputy (`production.write`) | **Resolved** | RT-04b |
| F-11 | Low | Likeness in visual identity | **Partially resolved** | RT-19 holds for "lookalike"/"resembles" wording. N-02: naming a person passes, and the anchors are not model-reviewed |
| F-12 | Low | Headers, `/health` disclosure | **Resolved** | RT-06 headers; minimal `/health` |
| F-13 | Low | 5xx leaks `error.message` | **Resolved** | `p2-hardening` test |
| F-14 | Low | Token policy | **Resolved** | Entropy check, expiry, rotation, rollover (tests, RA-07) |
| F-15 | Low | Docker hardening | **Resolved** | CI "Container (hardened compose)": read-only, `cap_drop ALL`, no-new-privileges, limits, `node` user, `0600` database |
| F-16 | Low | Unbounded provider bodies | **Resolved** | `p2-hardening` byte-cap tests |
| F-17 | Low | Audit coverage gaps | **Resolved** | Auth-failure events (bounded, RA-07), process execution log (test) |
| F-18 | Low | Classifier misses destructive verbs | **Resolved** | `p2-hardening` test |
| F-19 | Info | In-process enforcement | **Accepted** (documented) | `docs/security/trust-model.md`; RA-10 |
| F-20 | Info | ComfyUI and workflows trusted; none committed | **Open (owner)** | Pins are available; no workflow is committed (`workflows/README.md`) |
| F-21 | Info | Executables from `.env` | **Mitigated** | Optional SHA-256 pins, absolute paths required |
| F-22 | Info | No model independence | **Open** | Unchanged with one local model |
| F-23 | Info | Data at rest | **Resolved** (residual) | `0600`/`0700` (RA-06 includes WAL/SHM), retention, backup. Residual: N-03 |
| F-24 | Info | Auditor independence | **Open, and worse** | This re-audit was performed by the same AI system that wrote the remediations it reviews. See the disclosure in `SECURITY_REAUDIT_FINAL.md` |

## Documentation items (D-01 … D-24)

| Items | Status |
|---|---|
| D-01 (human gate not enforced against callers), D-23 (insecure default) | Resolved with F-01/F-04 |
| D-11 … D-18 | Resolved in P2 (README, package, notes errata, Docker docs) |
| D-19 | Resolved (origin and apparent age come from the identity) |
| D-20 | Resolved (code-assigned trend provenance) |
| D-21 | Unknown (Phase 1–5 specifications are not in the repository) |
| D-22 | Open (no IP-Adapter workflow committed; owner) |
| D-24 | Partially resolved (CI exists; no protection; see F-07) |
| **New documentation inaccuracies** | `sdlc-runbook.md` §6 and `trust-model.md` overstate what head anchoring detects (N-03). The `media-store.ts` comment overstates the `O_NOFOLLOW` protection (N-06). The P2 status document's gate verdict is superseded by this re-audit |
