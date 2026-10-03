# 05 — Remediation Roadmap (re-audit)

## P0 — before any further production runs with untrusted ideas or goals

| # | Finding | Remediation | Regression test |
|---|---|---|---|
| R2-01 | N-01 (High) negative prompts bypass the gate | Make negative prompts code-authored only (`STANDARD_NEGATIVES` plus fixed technical terms), **or** include the model-authored part in `materialForReview` and `assertIdentityPreserved` and refuse negatives that negate adult or age attributes | RA-01 → BLOCK, 0 image requests |
| R2-04 | N-04 (Medium) unvalidated backstop | Owner run: the R-02 corpus plus the RA-04 phrasings through `production.safety_review` on LM Studio `google/gemma-4-12b-qat`; record recall/precision in an audit note; set a minimum. Add the obvious heuristic terms (prepubescent, sweet sixteen, school years/exams, learner permit) | Recall report committed; RA-04 misses ≤ 2 for the heuristic layer |

## P1 — next iteration

| # | Finding | Remediation | Regression test |
|---|---|---|---|
| R2-03 | N-03 forged checkpoint | Accept a checkpoint only when a later, chain-valid `RETENTION_APPLIED` event carries the same `{sequence, hash}`; correct runbook §6 and the trust model | RA-03 → `verifyChain ok: false` |
| R2-02 | N-02 likeness by name | Model-review visual-identity anchors when a version is created; review the anchors inside the pre-generation material (exclude only the fixed template text) | RA-02 → refused |
| R2-08 | F-07 residual | Owner: create `main`, protect it with the 4 required checks (runbook), enable secret scanning and push protection, decide on Dependabot PRs #1–#3 | Unprotected push refused |

## P2 — hardening

| # | Finding | Remediation |
|---|---|---|
| R2-05 | N-05 | Worst-case price for unpriced cloud calls, or refuse unpriced models while a budget is set; ElevenLabs character estimate |
| R2-06 | N-06 | Verify the opened descriptor (device+inode or real path); give ffmpeg/ffprobe verified inputs; fix the comment |
| R2-07 | N-07 | Owner token to an owner-only file instead of logs; rotation guidance |
| R2-09 | N-08, N-09, N-11, N-12 | Relative asset paths and an `audit` scope for security events; optional origin port restriction; rowid-based staleness; expiry for the rollover token |
| — | F-22, F-20 | A second independent model provider for reviews; commit and pin the reviewed ComfyUI workflows (owner) |
