# Forge — Environments & Deployment

**Status**: Authoritative for environment topology, data promotion, and secrets workflow.
**Companion docs**: `08_Tech_Stack.md` §16 (Pulumi + GitHub Actions + CF Workers Builds), `09_Project_Structure.md` (local dev profiles).

> 3 cloud environments (dev/staging/prod). No per-engineer cloud envs — the local `real` dev profile replaces them. Pulumi-managed with strict secrets governance for prod.

---

## 1. Environment topology

| Env | Purpose | Realism | Who deploys |
|---|---|---|---|
| **`dev`** | Shared integration testing + target for local `real` dev profile's dev-shared creds | Full stack, real model + real sandbox (via dev-shared Secrets Store scope) | Platform team (on push to `dev` branch) |
| **`staging`** | Pre-prod gate; full stack; sanitized prod data for flywheel tuning | Full stack, real model + real sandbox + sanitized prod data | Platform team (on merge to `main`) |
| **`prod`** | The real thing — serves real users | Full stack, real everything | Platform team (on tagged release + 2-person approval) |

### Why no per-engineer cloud envs

The local `real` dev profile (`09` §5) gives engineers real-model + real-sandbox locally via dev-shared Secrets Store credentials. This covers ~90% of what per-engineer cloud envs would provide, at zero cloud cost and zero provisioning overhead. Per-engineer cloud envs are overhead Forge doesn't need.

---

## 2. Pulumi stacks

One Pulumi stack per environment:

```
infra/pulumi/
├── Pulumi.yaml              # project config
├── Pulumi.dev.yaml          # dev env (shared integration)
├── Pulumi.staging.yaml      # staging env
├── Pulumi.prod.yaml         # prod env
└── src/                     # the Pulumi program (TS)
```

Each stack defines the full CF resource surface (Workers, DOs, D1, R2, KV, Queues, Vectorize, AI Gateway, Access, etc.) + external SaaS (ClickHouse Cloud, Grafana Cloud) + secrets references. Stack differences are config-driven (resource names, tiers, secrets scope).

---

## 3. Data promotion

### Prod → staging (nightly, sanitized)

A nightly Pipelines job copies prod `session_event` data to staging ClickHouse **after verifying it's already sanitized** (the projection happens at the DO→Pipelines boundary in prod — see `18_Security_Contracts.md`). Staging never sees raw prod data; it receives the safe projection.

- **ClickHouse analytics**: sanitized projection copied nightly.
- **D1 control-plane state**: synthetic in staging (no copy — staging has its own repos, users, sessions created via dogfooding).
- **R2 audit**: never copied (audit is append-only, env-specific).

### No data promotion to prod

Prod is sourced only from real user activity. No data is ever copied *into* prod from lower envs.

---

## 4. Secrets management

### Source of truth

CF Secrets Store (per env). Secrets are referenced by name in Pulumi + wrangler configs — never in plaintext in the Pulumi program or git.

### Promotion workflow (dev → staging → prod)

**Pulumi-managed with CI gate + 2-person approval for prod:**

1. Platform engineer updates a secret via `pulumi config set-secret <name> --stack <env>` (interactive prompt for value, encrypted, stored in CF Secrets Store).
2. Commits the Pulumi config change (the encrypted reference, not the value).
3. CI runs `pulumi up` to apply.
4. **For prod**: GitHub Actions environment protection requires **2-person approval** before the deploy runs.
5. Audit trail: git commit on Pulumi config + CF Secrets Store access logs.

### Drift detection

`pulumi diff` on every CI run flags any drift between Pulumi config and live state. Manual secret updates (outside Pulumi) would be caught.

### Secret rotation

Rotation cadence defined per secret type (runbook — Tier 3). Provider API keys: quarterly or on incident. GitHub App key: annual. User OAuth tokens: refresh per-session.

---

## 5. Deploy pipelines

| Unit | Trigger | Pipeline |
|---|---|---|
| `control-plane` Worker | Push to `dev`/`main`, or tag for prod | GitHub Actions → `wrangler deploy` (via CF Workers Builds) |
| `web` Worker | Same | Same |
| `domain` package | Not deployed (workspace) | — |
| `plugin-sdk` package | Manual `pnpm publish` | GitHub Actions release workflow |
| Sandbox images | Push to `infra/images/sandboxes/` | GitHub Actions → `docker build` → cosign sign → push to GHCR |
| MCP servers | Push to `infra/images/mcp-servers/` | Same (unified OCI pipeline — ADR-0007) |
| Pulumi stack | Push to `infra/pulumi/` or manual | GitHub Actions → `pulumi up` (env-gated) |

### Environment promotion

- `dev` branch → `dev` env (automatic on push).
- `main` branch → `staging` env (automatic on merge).
- Git tag `v*` → `prod` env (manual trigger + 2-person approval).

### Rollback

- Workers: `wrangler rollback` (CF keeps previous version).
- Sandbox images / MCP servers: redeploy previous GHCR digest (tag-pinned in config).
- Pulumi: `pulumi destroy` + `pulumi up` at previous commit (last resort; rare).

---

## 6. DNS + routing

- `dev.forge.internal.example.com` → dev env (CF Access protected).
- `staging.forge.internal.example.com` → staging env (CF Access protected).
- `forge.internal.example.com` → prod (CF Access protected).

All behind Cloudflare Access (Zero Trust) federating to Google Workspace (08 §10).

---

## 7. Observability per env

| Env | OTel export | Retention |
|---|---|---|
| dev | ClickStack (dev ClickHouse) | Short (7 days) |
| staging | ClickStack (staging ClickHouse) + sanitized prod data | Medium (30 days) |
| prod | ClickStack (prod ClickHouse) + Grafana Cloud | Long (per `12` §5 TTL) |

---

## 8. What this doc does NOT specify

- **Capacity planning / autoscaling thresholds** — CF auto-scales Workers/DOs; sandbox concurrency tuned during pilot.
- **Disaster recovery / multi-region** — CF is global; ClickHouse Cloud has its own HA. Defer to runbook (Tier 3).
- **Cost monitoring per env** — budget alerts configured in Grafana per env (see `08` §17).
