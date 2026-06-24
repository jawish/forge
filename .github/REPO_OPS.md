# Forge — repository operations (one-time setup)

The checklist items that require GitHub repo settings (not code). A Platform
admin runs these once. Each maps to `IMPLEMENTATION_CHECKLIST.md` §2.4 / §2.6.

## §2.4 — Branch protection on `main`

Apply via `gh` (repo must have a remote):

```sh
gh api -X PUT repos/:owner/:repo/branches/main/protection -F required_status_checks[strict]=true \
  -F required_status_checks[contexts][]='tsc --noEmit (per package)' \
  -F required_status_checks[contexts][]='Oxlint + Oxfmt' \
  -F required_status_checks[contexts][]='Unit tests (~15% — pure logic in domain/)' \
  -F required_status_checks[contexts][]='Seam tests (~80% — real DO/router/harness via miniflare)' \
  -F enforce_admins=true \
  -F required_pull_request_reviews[required_approving_review_count]=1 \
  -F required_pull_request_reviews[dismiss_stale_reviews]=true \
  -F restrictions= \
  -F required_linear_history=true
```

Requirements (per `docs/16_Testing.md` §4 + `IMPLEMENTATION_CHECKLIST.md` §2.4):

- **Required status checks** before merge: the four blocking CI jobs
  (`typecheck`, `lint`, `test-unit`, `test-seam`). At §5.28, add `e2e-blocking`
  once the 5 critical paths turn blocking.
- **1 reviewer** required.
- **Linear history** (no merge commits; rebase or squash).
- **Strict** on status checks (require branches up to date with `main`).

## §2.6 — Validate

Open a no-op PR against `main` and confirm:

1. CI runs all four blocking jobs.
2. Merge is **blocked** until CI is green AND a reviewer approves.
3. `gh pr checks` reports the required contexts.

```sh
gh pr create --base main --head <your-branch> --title 'ci: validate gate' --body 'no-op PR to confirm branch protection'
gh pr checks --watch
```
