# 04 — Supply Chain and Repository (re-audit)

## Dependencies

| Check | Result |
|---|---|
| `npm audit --omit=dev` | **0** vulnerabilities |
| `npm audit` (full tree) | 4 moderate (drizzle-kit → @esbuild-kit → esbuild, GHSA-67mh-4wv8-2f99). Dev-only; documented ignore in `osv-scanner.toml`, expiring 2027-01-31; no non-breaking fix |
| osv-scanner 2.6.0 (CI, run `37108326196`) | No issues beyond the documented ignore (247 lockfile packages) |
| Runtime SBOM | `sbom-runtime.cdx.json` (this folder), CycloneDX 1.5, **87** components (`npm sbom --omit=dev`) |
| Secrets | gitleaks 8.30.1 (checksum-verified): full history (27 commits) and working tree, **no leaks**. No `.env`, database or key files are tracked (`git ls-files`) |
| Tokens in logs | None (RA-05) |

## CI (`.github/workflows/ci.yml`)

- 4 jobs, all green on `3318a43`:
  - typecheck/test/build
  - dependency audit + osv + SBOM
  - gitleaks (full history)
  - hardened container
- Least privilege: `permissions: contents: read` and `persist-credentials: false`.
- Pinning: actions are pinned to full commit SHAs, and scanner binaries are checksum-verified.
- **Fork pull requests run CI**, including `docker compose build` of fork code, on GitHub-hosted runners with a read-only token and no secrets. This is the standard, acceptable model. There is no `pull_request_target`.

## Repository state (verified via the GitHub API)

| Item | State | Risk |
|---|---|---|
| **Visibility** | **Public** | The code, the audit documents and the red-team proofs-of-concept are world-readable. No secrets were found. The documents describe now-fixed weaknesses plus the open N-01/N-03, so N-01 should be fixed before advertising the repository |
| Default branch | `claude/busy-pascal-h6hvhh` (the working branch) | No `main` |
| Branch protection / rulesets | **None** (`protected=false` on all 4 branches; `rulesets: []`) | Anyone with write access can push unreviewed changes or force-push; CI does not gate merges |
| Dependabot | Active: 3 open pull requests | See below |
| Security features (`security_and_analysis`) | Not readable with this session's permissions | Owner to check (secret scanning and push protection are free for public repositories) |

### Open Dependabot pull requests

| PR | Change | CI | Assessment |
|---|---|---|---|
| Jatin18012000/Jovi-Ai-Influencer-model-#1 | Docker base `node:22` → `node:26` (major) | green | Do **not** merge blindly: a major runtime change, outside `engines` testing (CI runs Node 22). Consider pinning Dependabot to Node 22 LTS updates |
| Jatin18012000/Jovi-Ai-Influencer-model-#2 | dev-dependencies group (@types/node, typescript, vitest) | **red** (`ERR_MODULE_NOT_FOUND`) | Breaks the build. With no protection, nothing stops a merge |
| Jatin18012000/Jovi-Ai-Influencer-model-#3 | `better-sqlite3` 12 → 13 (major, native) | green | Review the changelog; native ABI change |

**Conclusion (Gate L):** the controls exist and work. CI catches a broken dependency update (#2), but **enforcement is missing**: without protection, CI is advisory. This is the same condition as after P1, and it is more pressing now that the repository is public.
