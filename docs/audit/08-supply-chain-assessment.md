# 08 — Supply-Chain & AI Supply-Chain Assessment

## 1. Tools used and tools missing

| Tool | Available | Used |
|---|---|---|
| `npm audit` (GitHub Advisory DB) | yes | full and `--omit=dev` |
| `npm sbom` (CycloneDX) | yes | `docs/audit/sbom-runtime.cdx.json` (CycloneDX 1.5, 87 runtime components) |
| Semgrep, OSV-Scanner, Trivy, Gitleaks, TruffleHog, Syft, Grype, cyclonedx-npm | **missing** | Not installed. Per the audit rules, no third-party scanners were downloaded |
| Secret scanning | substitute | Regex scan of the working tree and the **entire git history**: provider key formats (Anthropic, OpenAI, Google, GitHub, Slack, AWS), private keys, JWTs, and `*_KEY/TOKEN/SECRET/PASSWORD=` assignments |

## 2. Results

| Check | Result |
|---|---|
| Runtime dependency vulnerabilities (`npm audit --omit=dev`) | **0** |
| All dependencies | **4 moderate, dev-only**: `drizzle-kit` → `@esbuild-kit/esm-loader` → `@esbuild-kit/core-utils` → `esbuild` ([GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99), the dev server answers cross-origin requests). The fix offered is a semver-major downgrade (`drizzle-kit@0.18.1`); **not applied** (audit rules). Exposure exists only while running `drizzle-kit` dev tooling |
| Lockfile | Present; 247 packages; **every entry resolved from `registry.npmjs.org` with an `integrity` hash** |
| Version ranges | `package.json` uses `^` ranges (and `~` for TypeScript). The lockfile pins exact versions; `npm ci` (Dockerfile) honours it |
| `.npmrc` | `legacy-peer-deps=true`: weakens peer-dependency conflict detection (documented workaround) |
| Install-time code | `better-sqlite3` (runs `prebuild-install`: **downloads a prebuilt native binary from GitHub releases at install time**, outside lockfile integrity, with a compile fallback), `esbuild` ×3 (dev; platform binary packages), `fsevents` (optional, macOS) |
| Secrets in the tree or history | **None found** (only test fixtures such as `top-secret-token`, `test-key` and `quoted-secret`). `.env` was never committed; only `.env.example` |
| Large binaries, media or databases in git | None (2.1 MiB repository) |
| CI/CD | **None**: no GitHub Actions, so there is no automated test, audit, secret-scan, SBOM or provenance gate |
| Branch protection | The only branch is `claude/busy-pascal-h6hvhh`; there is **no `main`**. Commits are pushed directly by two identities (owner and AI agent); there are no signed commits and no tags |
| Docker base images | `node:22-bookworm-slim` by **tag** (not digest); `apt-get install` of build tools unpinned |

## 3. AI / model supply chain (section 16)

| Asset | Control | Status |
|---|---|---|
| LM Studio models | Jovi **never downloads or loads** models: it only lists them (`/api/v1/models`, `/api/v0/models`, `/v1/models`) and calls chat completions | **PASS** (code review: `src/integrations/lmstudio/lmstudio-client.ts`; no download endpoints are used) |
| Model identity / provenance | `LM_STUDIO_MODEL` is a free-text id; the selected model is recorded per call in `model_runs`. There is **no hash or signature pinning** of the model file | PARTIAL |
| Cloud models | Model ids come from config; keys come from env; key headers are kept out of URLs (`cloud-providers.ts:158`) | PASS |
| ComfyUI workflows | Operator-supplied JSON paths; Jovi only fills placeholders. **No workflow is committed** (`workflows/.gitkeep`), so the IPAdapter/PuLID workflow cannot be audited | NOT_TESTABLE |
| ComfyUI custom nodes / Hugging Face weights | Outside Jovi. Custom nodes run arbitrary Python inside ComfyUI with the user's privileges | Trust assumption (F-20) |
| Prompt templates | Versioned in git; no secrets; identity rendered from the DB | PASS |
| Embedding models | None exist (semantic memory is keyword-based) | N/A |
| Auto-download of packages, scripts, binaries or workflows at runtime | **None found** (grep: no `npm install`, `pip`, `curl`, `fetch` to code hosts, or dynamic `import()` in `src/` or `apps/`) | **PASS** |
| Executables (ffmpeg, ffprobe, say) | Paths come from operator config; **not verified** by hash or signature | PARTIAL (F-21) |

## 4. Gaps against SSDF / CIS / SLSA-style minimums

1. No CI pipeline, so nothing enforces tests, typecheck, `npm audit`, secret scanning or SBOM generation on change (SSDF PW.7/PW.8/RV.1; CIS 16.x).
2. No protected default branch, no required review, no signed commits (SSDF PS.1/PS.2; CIS 16.1).
3. No dependency update policy or Dependabot/Renovate; no OSV monitoring (SSDF RV.1; CIS 7.x).
4. No provenance or attestation for the Docker image; base image not pinned by digest (SSDF PS.3).
5. Native binary download during install (better-sqlite3) is not covered by lockfile integrity.
6. AI-specific: no allow-list of approved model ids or hashes and no registry of approved ComfyUI workflows or custom nodes.

Overall supply-chain maturity: **2/5 (partial)**. Lockfile hygiene is good and runtime vulnerabilities are zero, but there is no automation or provenance.
