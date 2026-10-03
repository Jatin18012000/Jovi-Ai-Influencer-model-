# SDLC Runbook: Owner Steps for R-07

Security remediation R-07 (audit F-07) has two parts:

- **Repository files** (committed): `.github/workflows/ci.yml`, `.github/dependabot.yml`, `.gitleaks.toml`, `osv-scanner.toml`, and the digest-pinned `docker/Dockerfile`.
- **Repository settings:** only the owner can change these. They are listed below.

State on 2026-10-03:
- The repository has one branch, `claude/busy-pascal-h6hvhh`. It is unprotected and is currently the default branch; there is no `main`.
- CI run #1 on that branch passed.
- Dependabot runs against the default branch, so it is already active there. Its update pull requests will target `main` once `main` is the default.

## 1. Create `main` from a reviewed commit

Review the branch first. Then, from a local clone:

```bash
git fetch origin
git push origin origin/claude/busy-pascal-h6hvhh:refs/heads/main
```

Then make `main` the default branch: GitHub → *Settings → General → Default branch → main*.

## 2. Protect `main`

Use either GitHub → *Settings → Rules → Rulesets → New branch ruleset* (target: `main`), or branch protection.

Turn on:
- **Require a pull request before merging**, with at least 1 approval. Dismiss stale approvals when new commits are pushed.
- **Require status checks to pass:** select these three CI jobs. They appear after the workflow has run once.
  - `Typecheck, test, build`
  - `Dependency audit + SBOM`
  - `Secret scan (gitleaks, full history)`
- **Require branches to be up to date before merging.**
- **Block force pushes** and **restrict deletions**.
- **Require linear history** (optional).
- **Require signed commits** (recommended once your signing key is set up).

Equivalent API call (classic branch protection). Run it as the owner with a token that has admin rights:

```bash
gh api -X PUT repos/jatin18012000/jovi-ai-influencer-model-/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Typecheck, test, build", "Dependency audit + SBOM", "Secret scan (gitleaks, full history)"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 1, "dismiss_stale_reviews": true },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": true
}
JSON
```

## 3. Repository security settings

Under *Settings → Code security*, enable:
- Dependency graph.
- Dependabot alerts.
- Dependabot security updates.
- Secret scanning and push protection, if available for the repository.

Under *Settings → Actions → General*:
- **Workflow permissions:** "Read repository contents".
- **Allow GitHub Actions to create and approve pull requests:** off.
- **Actions permissions:** "Allow … actions and reusable workflows" limited to the ones used: `actions/checkout`, `actions/setup-node` and `actions/upload-artifact`. Gitleaks and osv-scanner are downloaded as checksum-verified binaries, not actions.

## 4. Tag phase releases

Tag each reviewed phase on `main`, signed if you can:

```bash
git tag -s phase-9.5-security -m "Security hardening: P0 (R-01..R-04) + P1 (R-05..R-08)"
git push origin phase-9.5-security
```

## 5. Keep pins current

Dependabot proposes updates for:
- npm packages;
- GitHub Actions (SHA pins);
- the `node:22-bookworm-slim` base-image digest.

Updates to the scanner versions in `ci.yml` (`GITLEAKS_*`, `OSV_SCANNER_*`) are manual:
1. Take the new version's SHA-256 from that release's checksum file.
2. Update the version and the hash together.

`osv-scanner.toml` ignores carry an expiry date (`ignoreUntil`). When one expires, CI fails until the advisory is re-assessed.

## 6. Audit-log anchoring (R-08)

The event log is hash-chained. Someone with write access to `data/jovi.db` can still append a fully re-hashed forgery at the end of the chain. To detect that, periodically (for example daily, and before any publishing decision):

1. Run `npm run jovi -- --audit-verify`.
2. Store the printed head (`#sequence hash`) somewhere the Jovi machine cannot write: a password manager note, a ticket, or an email to yourself.

A later head that does not extend a recorded one means the log was rewritten.

> **Limitation (re-audit N-03).** Anchoring detects rewrites of the *tail*. It does **not** detect deletion of a *prefix* hidden behind a forged retention checkpoint: the head stays the same. Until R2-03 is implemented (checkpoints cross-checked against chained `RETENTION_APPLIED` events), also record:
> - the checkpoint list (`SELECT * FROM audit_checkpoints`);
> - the oldest remaining event sequence.
>
> Compare both on each check.
