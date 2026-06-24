# Forge

Internal agentic software-factory platform: secure sandboxed dev environments, deep company context, closed-loop verification, Slack-first + Web entry, user-attributed PRs. Inspired by Ramp Inspect; evolved with 2026 learnings.

> **Status:** pre-implementation. This repo currently holds the design suite (`docs/`) and the build plan. No code yet — the first task is `IMPLEMENTATION_CHECKLIST.md` §1.

---

## What lives where

| Path | What |
|---|---|
| `docs/00_INDEX.md` → `19_Integration_Contracts.md` | **Locked design specs.** Authoritative for *what* and *why*. Read before building. |
| `docs/adr/` | Architectural Decision Records for the surprising choices (all-CF, ClickHouse unification, TanStack Start, OpenCode+Agents SDK, Rekor, TS 7, unified artifact pipeline). |
| `CONTEXT.md` | Glossary of canonical domain terms (Session, Prompt, Sandbox, Trust Anchor, …). |
| `docs/07_Implementation_Roadmap.md` | **Build order & phasing** (engineering execution track, aligned to the specs). |
| `IMPLEMENTATION_CHECKLIST.md` | **Tickable step-by-step build list.** Start here when implementing. |

Target layout once code lands (`docs/09_Project_Structure.md` §1):

```
apps/control-plane/   # CF Worker: tRPC API + WS gateway + Slack + SessionDO + Queue/Workflow consumers
apps/web/             # CF Worker: TanStack Start (UI + tRPC client), no DO bindings
packages/domain/      # one package, four concerns: types / schemas(zod) / otel / config
packages/plugin-sdk/  # MCP author SDK (published to npm separately)
infra/pulumi/         # IaC (TS): CF + ClickHouse Cloud + Grafana Cloud, 3 stacks
infra/images/         # OCI → GHCR: sandboxes/ (Chainguard-derived) + mcp-servers/
```

---

## Local development

**Prerequisites:** [`mise`](https://mise.jdx.dev) (`brew install mise`), `git`, `docker` (for local ClickHouse + image builds). A Cloudflare account is **not** needed for the `fast` profile.

### Install everything

```sh
mise install        # installs node 22, pnpm 10, pulumi 3 (versions pinned in .mise.toml)
```

### Two dev profiles (`docs/09_Project_Structure.md` §5)

| Profile | Command | Model | Sandbox | Credentials | Use for |
|---|---|---|---|---|---|
| **`fast`** | `mise dev` | Mock (canned streams) | Local subprocess (`LocalSandboxProvider`) | **None** | Inner-loop UI/API/schema work. <30s start. |
| **`real`** | `mise dev:real` | Real (AI Gateway, dev-shared keys) | Real CF Sandbox (dev account) | Dev-shared (CF Secrets Store `dev` scope) | Agent behavior, classifier, audit pipeline, demos. |

`fast` is the default and needs zero setup. `real` is unlocked once one Platform member provisions dev-shared credentials (`docs/09_Project_Structure.md` §5) — **no per-engineer procurement.**

Both profiles run workerd locally (miniflare-emulated D1/R2/KV/Queues/DO SQLite) and export OTel spans to the console. `real` adds a local ClickHouse (Docker) for analytics/audit testing.

### Common tasks

```sh
mise dev            # start the fast profile (workerd + web + control-plane, parallel)
mise dev:real       # start the real profile (needs dev-shared creds)
mise build          # build all packages + apps
mise test           # all unit + seam tests (Vitest)
mise test:unit      # unit only (fastest)
mise test:watch     # Vitest watch mode
mise test:e2e       # Playwright (requires a dev profile running)
mise lint           # Oxlint + Oxfmt format check
mise deploy         # deploy control-plane + web to CF (requires env creds)
```

> If `mise <task>` isn't available yet, the tasks haven't been added (that's `IMPLEMENTATION_CHECKLIST.md` §1.4). The list above is the target, verbatim from `docs/09_Project_Structure.md` §4.

### Testing shape (`docs/16_Testing.md`)

Integration-heavy ("testing trophy"): ~15% pure unit (`packages/domain`), ~80% seam tests (real DO/router/harness via miniflare, externals mocked **at the boundary only**), ~5% E2E (Playwright). **Real-model / agent-behavior tests run on `staging` only — never in CI** (non-determinism).

CI gate is risk-allocated: `tsc` + Oxlint + unit + seam tests are **blocking**; the ~5 critical E2E paths (login, create session, view session, submit prompt, cancel) are blocking; the rest is advisory.

---

## Environments (`docs/17_Environments.md`)

Three cloud envs — **no per-engineer cloud envs** (the local `real` profile replaces them):

| Env | Deploys from | Trigger |
|---|---|---|
| `dev` | `dev` branch | automatic on push |
| `staging` | `main` branch | automatic on merge |
| `prod` | git tag `v*` | manual + 2-person approval |

All behind Cloudflare Access (federating to Google Workspace). Pulumi-managed (one stack per env); secrets in CF Secrets Store.

---

## Tech stack (summary — `docs/08_Tech_Stack.md` is authoritative)

Cloud: Cloudflare (sole cloud) — Workers + Durable Objects, Sandbox, AI Gateway, Browser Run, R2/D1/KV/Vectorize, Queues/Workflows/Pipelines, Secrets Store, Access. Observability/analytics: ClickHouse Cloud + ClickStack + Grafana. Trust anchor: Sigstore Rekor. Agent harness: OpenCode (MCP-native, configured not forked). Transport: Cloudflare Agents SDK + Client SDK. Frontend: TanStack Start + shadcn/ui + Tailwind v4 + Tremor. Toolchain: pnpm + TypeScript 7 (TS 6 fallback) + Oxlint/Oxfmt + Vitest/Playwright + Pulumi.

---

## Using Forge (onboarding)

Internal docs for engineers, PMs/designers, and repo champions live in
[`internal-docs/`](./internal-docs/). Start with the
[5-minute getting-started](./internal-docs/getting-started.md) and the
[Slack flow walkthrough](./internal-docs/slack-flow-walkthrough.md). Repo owners:
see the [champion guide](./internal-docs/champion-guide.md).

## Observability dashboards

The 5 standard Grafana dashboards (session overview, agent behavior, cost,
reliability, audit — docs/14 §6) live in [`infra/grafana/dashboards/`](./infra/grafana/dashboards/),
built on the ClickHouse analytics lake (docs/12 §5). See
[`infra/grafana/README.md`](./infra/grafana/README.md) for provisioning.

## Contributing

1. Read `docs/00_INDEX.md` + `CONTEXT.md`, then the spec(s) relevant to your change.
2. Pick the next unchecked item in `IMPLEMENTATION_CHECKLIST.md` (or open one if extending).
3. TDD at the seam; one commit per checkbox; reference the slice in the commit message.
4. CI gate + 1 reviewer required for `main`. Prod needs a tagged release + 2-person approval.
5. If you made a surprising decision, write an ADR in `docs/adr/`.

Design questions → the relevant `docs/NN_*.md`. Build-order questions → `docs/07_Implementation_Roadmap.md`. Step questions → `IMPLEMENTATION_CHECKLIST.md`. Usage questions → [`internal-docs/`](./internal-docs/).
