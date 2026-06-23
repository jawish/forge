# Forge — Project Structure & Topology

**Status**: Authoritative for monorepo layout, Worker topology, and local dev environment.
**Companion docs**: `08_Tech_Stack.md` (vendors), `10_API_Contracts.md`, `11_State_Model.md`, `12_Data_Schemas.md`.

> Captures the decisions: pnpm+mise monorepo, 2-Worker topology (split by deployment cadence), unified `domain` package, and two-profile local dev.

---

## 1. Monorepo layout

Split on **artifact shape + consumer**, not conceptual category. Three top-level directories, each holding one kind of artifact:

```
forge/
├── apps/                     # CF Worker deploy units (wrangler)
│   ├── control-plane/        # API + WS gateway + Slack bot + DOs + Queue consumers
│   └── web/                  # TanStack Start (UI + tRPC client)
├── packages/                 # TS npm packages (workspace consumers)
│   ├── domain/               # types/ schemas/ otel/ config/ — one package
│   └── plugin-sdk/           # MCP author SDK (published to npm separately)
├── infra/                    # Non-Worker infrastructure
│   ├── pulumi/               # IaC program (TS, runs in CI to provision CF + SaaS)
│   └── images/               # OCI artifacts → GHCR (unified pipeline, ADR-0007)
│       ├── sandboxes/        # base sandbox Dockerfiles (Chainguard-derived)
│       └── mcp-servers/      # platform-provided MCP server sources
├── docs/                     # Markdown specs (this file, 00-08, ADRs)
├── CONTEXT.md                # Glossary
├── .mise.toml                # Tool versions + task definitions
├── pnpm-workspace.yaml       # Workspace config
├── package.json              # Root scripts + dev deps
└── tsconfig.base.json        # Shared TS config (TS 7 strict)
```

### Why these boundaries

- **`apps/`** = things that deploy as CF Workers. Each has its own `wrangler.jsonc` and deploys independently. The deployment unit of Forge.
- **`packages/`** = TS libraries consumed via pnpm workspace protocol. They are *not* deployed; they're imported by apps.
- **`infra/`** = everything that isn't a Worker but needs building/provisioning. Sub-split by artifact shape: `pulumi/` (runs in CI to provision), `images/` (builds to OCI → GHCR).
- **MCP servers and sandbox images share `infra/images/`** because they're the same artifact shape (OCI → GHCR) governed by the unified pipeline (ADR-0007). Don't split them across packages/ and infra/.

---

## 2. The `domain` package — one package, four concerns

The single most important structural decision. Types, zod schemas, OTel attribute names, and config schemas **change together** (adding a `ToolCall` field touches all four) — so they live in **one package** with subdirectories, not four packages that release in lockstep.

```
packages/domain/
├── src/
│   ├── types/              # Plain TS types (Session, Prompt, ToolCall, Artifact, ...)
│   ├── schemas/            # Zod schemas (runtime parsers, derived from same source)
│   ├── otel/               # OTel attribute names, span names, ClickHouse table defs
│   └── config/             # .forge/ repo-config schema, env-config schema
├── package.json
└── tsconfig.json
```

**Rule**: if a change touches `types/`, it almost always touches `schemas/` (and often `otel/`). Keeping them in one package means one import, one version, one PR. The `plugin-sdk` is separate only because it's *published externally* and has a different release cadence.

---

## 3. Worker topology — 2 Workers, split by deployment cadence

Not 4 Workers (the microservice reflex). The control plane is **one trust domain** with shared DO bindings; splitting it into separate Workers adds wrangler configs, service-binding hops, and deploy pipelines for zero benefit on a single-team internal platform.

| Worker | Contains | Deploys when | Bindings |
|---|---|---|---|
| **`web`** | TanStack Start app (SSR + static assets + tRPC client) | UX changes (frequent) | None (calls control-plane via fetch) |
| **`control-plane`** | HTTP API (tRPC) + WS gateway route + Slack bot route + Session DOs + Queue/Workflow consumers | Business/session logic changes (stable) | DO namespace, D1, R2, KV, Vectorize, Queues, AI Gateway, Browser Run, Secrets Store |

### Routes on the control-plane Worker

```
/api/*            # tRPC v11 (fetchEdgeRequest adapter) — the Web↔control-plane seam
/ws/:sessionId    # WS gateway → SessionDO (Agents SDK Client SDK on the browser side)
/slack/events     # Slack Bolt (Events API ingestion + classifier)
/github/webhooks  # GitHub App webhooks (PR status → session status)
/internal/queue/* # Queue consumers (image builds, analytics pipeline, alert-triggered sessions)
```

All routes share the same bindings. The Slack bot spawns a session by calling `env.SESSION_DO.get(id)` directly — **no service-binding hop**, because it's the same Worker.

### Why not split the Slack bot / WS gateway / API?

- **Same trust domain** — all internal control-plane code, same CF Access identity.
- **Shared bindings** — they all need DO access; one Worker binds once.
- **No independent scaling benefit** — CF scales Workers per-route automatically.
- **No team-boundary benefit** — it's one platform team.
- **Coupled-deploy risk is theoretical** — CF Workers deploy near-zero-downtime; WS reconnection is handled by the Client SDK.

> See ADR-0003 for the realtime transport decision: the WS gateway is a route on the control-plane Worker, not a separate gateway Worker.

---

## 4. Build orchestration — pnpm + mise

| Concern | Tool | Why |
|---|---|---|
| Workspace / package install | **pnpm** | Locked in `08` §9. Strict about phantom deps, fast, monorepo-native. |
| JS task graph within packages | **`pnpm -r`** (topological) | Built into pnpm. Runs build/test/lint in dependency order across the workspace. No extra tool needed for the JS graph. |
| Toolchain versions (Node, pnpm, Pulumi CLI, etc.) | **mise** (`.mise.toml`) | Polyglot: Forge has Dockerfiles + Pulumi + TS. mise manages versions for all of them uniformly. Replaces `nvm`/`.nvmrc` + a separate task runner. |
| Cross-cutting tasks (dev, build-all, test-all, deploy) | **mise tasks** | Defined in `.mise.toml`; shell out to pnpm/wrangler/docker/pulumi as needed. One entry point for contributors. |

### Why not Turborepo/Nx

- Turborepo is TS/JS-only; Forge is polyglot (Dockerfiles, Pulumi, future Python tooling). mise handles all uniformly.
- Turborepo overlaps with `pnpm -r` (both run the JS task graph). Adding it introduces a third tool for a purely-JS benefit.
- Turborepo's remote caching is nice-to-have; mitigated by CI caching + pnpm store cache.
- Nx is heavier and more opinionated; overkill for a platform team.

### `.mise.toml` (canonical task list)

```toml
[tools]
node = "22"
pnpm = "10"
pulumi = "3"

[tasks.dev]
description = "Start local dev (fast profile: mocks, zero creds)"
run = "FORGE_DEV_PROFILE=fast pnpm -r --parallel dev"

[tasks."dev:real"]
description = "Start local dev (real profile: real model + CF Sandbox via dev creds)"
run = "FORGE_DEV_PROFILE=real pnpm -r --parallel dev"

[tasks.build]
description = "Build all packages + apps"
run = "pnpm -r build"

[tasks.test]
description = "Run all tests"
run = "pnpm -r test"

[tasks.lint]
description = "Lint + format check"
run = "pnpm -r lint"

[tasks.deploy]
description = "Deploy control-plane + web to CF (requires env)"
run = "pnpm --filter control-plane deploy && pnpm --filter web deploy"
```

---

## 5. Local dev environment — two profiles

Local dev serves two jobs with different realism needs. Don't pick one mode — switch by env var.

| Profile | Command | Model | Sandbox | Bindings | OTel | Use for |
|---|---|---|---|---|---|---|
| **`fast`** | `mise dev` | Mock (canned streams) | Local subprocess (via thin provider interface) | Local workerd (D1/R2/KV/Queues emulated) | Console exporter | Inner-loop UI/API/schema work. Zero credentials. <30s start. |
| **`real`** | `mise dev:real` | Real (via AI Gateway, dev-shared keys) | Real CF Sandbox (dev account, dev-shared creds) | Local workerd + dev-shared Secrets Store scope | Console + local ClickHouse (Docker) | Agent behavior, classifier, audit pipeline, integration work. Demos (point at dev GitHub org + dev Slack workspace). |

### Why two profiles (not one, not three)

- **Mocking is fine for UI work but actively harmful for agent-behavior work** — Forge's core value is realistic agent behavior. A `MockModelProvider` returning canned text doesn't exercise streaming UX, tool-call rendering, or cost tracking. Developing agent features against mocks gives false confidence.
- **Demo doesn't need a separate profile** — it's `real` pointed at dev orgs (dev GitHub org + dev Slack workspace). Same machinery, different target.
- **The thin provider interface (ADR-0001) earns its keep twice** — failover (prod) + local mock (`fast` profile). In `real`, the real CF Sandbox is used directly.

### Dev-shared credentials (the keystone of the `real` profile)

Per-engineer credential procurement (the reason "full real stack" is usually rejected) is eliminated by **dev-shared credentials in a CF Secrets Store dev scope**:

- One platform-team member provisions dev provider keys once (AI Gateway, CF Sandbox, optional Slack dev workspace + GitHub dev org).
- Stored in CF Secrets Store under a `dev` scope.
- `wrangler dev --env dev` reads them automatically.
- Every engineer's `mise dev:real` pulls the same dev-shared set — no per-engineer procurement.

### What's local in both profiles

- **ClickHouse**: local Docker container (`clickhouse/clickhouse-server`). Real engine for analytics/audit pipeline testing without ClickHouse Cloud.
- **OTel**: console exporter (logs spans to terminal). Grafana Cloud is for staging/prod, not dev feedback.

### What's mocked only in `fast`

- **Model**: `MockModelProvider` behind the AI Gateway interface — returns canned streaming responses for UI work. In `real`, the real AI Gateway is used.
- **Sandbox**: `LocalSandboxProvider` (implements the thin provider interface from ADR-0001) — runs commands in a local subprocess. In `real`, the real CF Sandbox is used.
- **GitHub**: mock for PR-creation logic testing. In `real`, a dev GitHub org is used.
- **Slack**: bypassed in `fast` (drive sessions from the web UI's "new session" button). In `real`, Slack Socket Mode on a dev workspace (no public URL needed).

---

## 6. Service-binding graph

Since there are only 2 Workers, the graph is trivial:

```
web ──fetch──→ control-plane ──┬──→ SessionDO (in-process: env.SESSION_DO.get(id))
                               ├──→ D1, R2, KV, Vectorize, Queues
                               ├──→ AI Gateway → providers
                               ├──→ Browser Run
                               └──→ Secrets Store
```

No service bindings between Workers (web calls control-plane via plain fetch over the tRPC endpoint). No cross-Worker DO hops (everything DO-related is in-process on the control-plane Worker).

---

## 7. Deployment units

| Unit | How deployed | Cadence |
|---|---|---|
| `control-plane` Worker | `wrangler deploy` (via CF Workers Builds on push, or `mise deploy` manually) | On session-logic changes |
| `web` Worker | `wrangler deploy` (via CF Workers Builds on push) | On UX changes (frequent) |
| `domain` package | Not deployed — workspace consumer | Versioned in-repo |
| `plugin-sdk` package | `pnpm publish` to npm (manual, semver) | On SDK changes |
| Sandbox images | `docker build` + push to GHCR (cosign-signed) | On image-config changes |
| MCP servers | `docker build` + push to GHCR (cosign-signed) | On MCP changes |
| Pulumi stack | `pulumi up` in CI (GitHub Actions) | On infra changes |
