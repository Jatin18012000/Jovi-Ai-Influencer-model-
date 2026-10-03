# Jovi Trust Model (R-17)

This page records what Jovi trusts, why, and what limits that trust. It covers audit findings:

- **F-19:** permission enforcement is in-process.
- **F-20:** ComfyUI and its workflows are trusted wholesale.
- **F-21:** configured executables are run.
- **F-22:** model independence.

## Trust boundaries

| Component | Trust | Why | What limits it |
|---|---|---|---|
| **Jovi code** (`src/`, `apps/`) | Trusted | First-party, reviewed, CI-tested | Agents get only a ToolKit. Every tool call is checked against the agent's allow-list and level, and recorded |
| **Agents** | Trusted code, untrusted *output* | Models never choose tools: an agent's code calls them | Output is Zod-validated, guarded for identity and safety, and tag-escaped as data for the next agent |
| **Model output** (LM Studio, cloud) | Untrusted data | Can be wrong, injected or adversarial | Treated only as data. Pre-generation safety gate (R-02); provenance labels (R-03); no execution path |
| **API callers** | Authenticated, scoped | Bearer credentials | Scopes (read/operate/approve/identity-admin); Host/Origin allow-list; rate limits; audit events |
| **CLI user** | Trusted (`local:<os user>`) | Shell access is the authentication | Interactive confirmation for approvals and identity changes |
| **`.env` / environment** | Fully trusted | Operator configuration | Write access to `.env` means code execution (it names executables). Keep it owner-only (`chmod 600 .env`) |
| **ffmpeg / ffprobe / `say`** | Trusted executables | Operator-installed | `shell: false`; arguments built from validated paths; text via stdin/SRT; timeouts; one log record per execution (R-08); **optional SHA-256 pins** |
| **ComfyUI** | Trusted service, no authentication | Local GPU server | Use loopback only (startup warning otherwise); uploads confined, no symlinks (R-09); response size caps (R-15); **optional workflow SHA-256 pins** |
| **ComfyUI custom nodes** | Trusted wholesale | Run inside ComfyUI with its privileges | Out of Jovi's control. Install only reviewed nodes; pinning the workflow does not pin node code |
| **LM Studio** | Trusted service | Local model server | Use loopback (startup warning otherwise); response size caps |
| **ElevenLabs / cloud models** | External service | API key in env | HTTPS; daily cloud budget (R-05); size caps; keys never logged or returned |
| **SQLite database** (`data/jovi.db`) | Trusted store | Local file | Owner-only permissions (R-18); hash-chained events; attested approvals (R-08). See *Residual risks* |

## Pinning executables and workflows (optional)

Pins make a silent replacement of a binary or workflow fail closed.

1. Record the hashes after installing or approving:

   ```bash
   shasum -a 256 /opt/homebrew/bin/ffmpeg /opt/homebrew/bin/ffprobe /usr/bin/say
   shasum -a 256 workflows/jovi-image.json workflows/jovi-video.json
   ```

2. Add them to `.env`:

   ```bash
   JOVI_FFMPEG_PATH=/opt/homebrew/bin/ffmpeg
   JOVI_FFMPEG_SHA256=<hash>
   JOVI_FFPROBE_PATH=/opt/homebrew/bin/ffprobe
   JOVI_FFPROBE_SHA256=<hash>
   MACOS_SAY_SHA256=<hash>
   COMFYUI_IMAGE_WORKFLOW_SHA256=<hash>
   COMFYUI_VIDEO_WORKFLOW_SHA256=<hash>
   ```

How the pins behave:
- A pinned executable must be an absolute path; configuration is refused otherwise.
- **Binaries** are hashed before every run, with the result cached until the file's size, modification time or inode changes. On a mismatch the run is refused with `BINARY_HASH_MISMATCH`.
- **Workflows** are hashed when loaded. A mismatched workflow makes the provider `MISCONFIGURED`.
- **Updates:** after a `brew upgrade ffmpeg`, or an approved workflow change, update the hash. Until then the provider is refused, which is the intended behaviour.

## Residual risks (accepted, documented)

- **In-process enforcement (F-19).** The permission guard is in-process, not a sandbox. It is sound because agents are first-party code and models never select tools. It would **not** contain a malicious third-party agent: never load agent code you have not reviewed.
- **Database write access.** A local attacker who can write `data/jovi.db` can:
  - append a fully re-hashed forged event to the end of the chain. Recording the chain head outside the machine detects this (runbook §6);
  - delete any prefix of the log behind a forged retention checkpoint. This is **not** detected by head anchoring (re-audit N-03); the fix is R2-03.

  Approval attestation detects naive edits.
- **Model independence (F-22).** With one local model, the generator, the evaluator, the QA model and the safety reviewer are the same model. The reviews are a second *pass*, not a second *opinion*. Configure a second provider for independent evaluation where it matters.
- **ComfyUI.** Workflows and custom nodes execute arbitrary code inside ComfyUI. Jovi treats ComfyUI as part of the trusted computing base.
- **Heuristic checks.** Identity, safety and likeness patterns are heuristics (labelled `HEURISTIC` in QA). The model-graded safety review and the human approval are the controls that count.
