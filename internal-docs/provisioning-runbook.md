# Forge — provisioning runbook (Platform admin)

The steps a Platform admin runs **once** to provision the cloud resources the
`real` dev profile, the Phase 0 spikes (§7), and prod depend on. These are the
human-provisioning blockers documented in `IMPLEMENTATION_CHECKLIST.md` §0.3,
§6.1, §6.6, §2.4 — none are code; all require authenticated access to the
Cloudflare dashboard + GitHub.

> **Why this is a human step:** `wrangler login` is interactive OAuth (opens a
> browser). The build environment has no `CLOUDFLARE_API_TOKEN` and can't run
> `wrangler login`. These resources also can't be created programmatically
> without first having an account + token — a chicken-and-egg only a human
> resolves by signing up.

## 1. Cloudflare account (§0.3)

1. Sign in to `dash.cloudflare.com` (or create the org account).
2. One Platform member needs **Admin** access (to manage Workers/DO/D1/R2/KV/
   Queues/Workflows/Pipelines/AI Gateway/Sandbox/Secrets Store/Access).
3. Create an API token for CI/dev:
   - Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template,
     scoped to the account + the Forge zone.
   - `export CLOUDFLARE_API_TOKEN=...` locally; set as a GitHub Actions secret
     (`CF_API_TOKEN`) for deploy pipelines.

Verify:
```sh
wrangler whoami   # should show the account
```

## 2. Dev-shared credentials → CF Secrets Store (§6.1)

One Platform member provisions these once; everyone else's `mise dev:real` pulls
the same set (docs/09 §5 — no per-engineer procurement).

| Secret | What | Where to get it |
|---|---|---|
| `AI_GATEWAY_ENDPOINT` | The AI Gateway URL (`https://gateway.ai.cloudflare.com/v1/<acct>/<gateway>`) | CF dashboard → AI Gateway → create |
| `AI_GATEWAY_KEY` | Gateway API key | AI Gateway settings |
| `AI_GATEWAY_PROVIDER` | Default provider (`anthropic` / `openai` / `google`) | your provider contract |
| `SANDBOX_ACCOUNT_ID` | CF account id (sandboxes live under the account) | dash.cloudflare.com |
| `SANDBOX_API_TOKEN` | API token with Sandbox permissions | Profile → API Tokens |
| `SLACK_SIGNING_SECRET` | Slack app signing secret | api.slack.com → your app |
| `SLACK_BOT_TOKEN` | Slack bot OAuth token (`xoxb-...`) | Slack app → OAuth & Permissions |
| `GITHUB_APP_PRIVATE_KEY` | Forge GitHub App private key (PEM) | GitHub → App settings |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth App (per-user PR attribution) | GitHub → OAuth Apps |

Store in the CF Secrets Store `dev` scope (referenced by name in
`apps/control-plane/wrangler.jsonc` + `.dev.vars` for local `mise dev:real`):

```sh
# Bind secrets to the control-plane Worker (dev env):
wrangler secret put AI_GATEWAY_KEY --env dev
# ... repeat for each
```

For local `mise dev:real`, mirror into `apps/control-plane/.dev.vars` (gitignored):
```
AI_GATEWAY_ENDPOINT=...
AI_GATEWAY_KEY=...
SANDBOX_ACCOUNT_ID=...
SANDBOX_API_TOKEN=...
```

Verify (§6.7): `mise dev:real` → the §5 slice runs against the real model + real
CF Sandbox locally.

## 3. Pulumi: provision the dev-stack resources (§6.6)

```sh
cd infra/pulumi
pulumi login   # or local: pulumi login --local
pulumi stack init dev
pulumi config set cloudflare:accountId <acct>   # from step 1
pulumi config set-secret cloudflare:apiToken <token>
pulumi up      # creates D1, R2 buckets, KV, Queue, AI Gateway
```

Outputs (`d1DatabaseId`, `kvNamespaceId`, …) feed the control-plane `wrangler.jsonc`
bindings for deployed envs. Local `mise dev:real` uses miniflare-emulated bindings.

## 4. GitHub repo + branch protection (§2.4, §2.6)

```sh
# Create the remote (one-time):
gh repo create <org>/forge --private --source=. --remote=origin --push

# Branch protection (the .github/REPO_OPS.md commands):
gh api -X PUT repos/:owner/:repo/branches/main/protection \
  -F required_status_checks[strict]=true \
  -F 'required_status_checks[contexts][]=tsc --noEmit (per package)' \
  -F 'required_status_checks[contexts][]=Oxlint + Oxfmt' \
  -F 'required_status_checks[contexts][]=Unit tests (~15% — pure logic in domain/)' \
  -F 'required_status_checks[contexts][]=Seam tests (~80% — real DO/router/harness via miniflare)' \
  -F 'required_status_checks[contexts][]=E2E (blocking critical paths)' \
  -F enforce_admins=true \
  -F required_pull_request_reviews[required_approving_review_count]=1 \
  -F required_linear_history=true
```

Validate (§2.6): open a no-op PR; confirm CI runs + merge is blocked until green +
reviewed.

## 5. Phase 0 spikes (§7) — once §1+§2 are done

- §7.1: benchmark CF Sandbox snapshot/restore (`CloudflareSandboxProvider.snapshot`
  + `.restore`); record vs the Modal baseline; ADR amendment if short.
- §7.2: build one Python + one TS repo image (Chainguard base, valid
  `.forge/config.toml`), cosign-sign, push to GHCR, verify snapshot+restore on dev.
- §7.3: AI Gateway eval to pick the frontier/default-coding/flex/classifier tier
  IDs; record choices in an ADR.
- §7.4: CF Access → Google Workspace (web front door) + per-user GitHub OAuth.
- §7.5: Security sign-off on the sandbox boundary + Outbound Workers manifest.

## 6. Vectorize seeding (§8.1)

After the Workers AI + Vectorize bindings are provisioned:
```sh
# Create the index (Pulumi widens to include this):
wrangler vectorize create forge-repo-classifier --dimensions 768 --metric cosine
# Seed pilot-repo descriptions/READMEs/commits (the router port is built).
```

---

After this runbook: every remaining checklist item is actionable. The code
(provider impls, Pulumi program, classifier, dashboards, E2E) is already in place;
this runbook provisions the live resources it runs against.
