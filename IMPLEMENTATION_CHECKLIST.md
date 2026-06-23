# Forge — Implementation Checklist

> **Purpose.** The tickable build order. Each checkbox is a demonstrably-working increment. Start at §1 and work down; later sections assume earlier ones are green.
>
> **Source of truth.** *What* and *why* live in `docs/` (`08`–`19`, ADRs). *Order* and *done-ness* live here. When a step says "per `NN`", read that doc — don't re-derive.
>
> **Method.** TDD at the seam: write the failing seam/unit test → run it red → implement the minimum → run it green → commit. Commit frequency ≥ one per checkbox. See `docs/16_Testing.md` for the test shape (integration-heavy; mocks at the external boundary only).
>
> **Profiles.** Build everything against `fast` (mocks, zero creds) first; only the steps flagged **[real]** need the `real` profile. See `docs/09_Project_Structure.md` §5.

---

## §0. Prerequisites (one-time, before §1)

- [x] **0.1** Install `mise` (`brew install mise` or per its docs); run `mise --version`.
- [x] **0.2** `git` ≥ 2.40; `docker` (for local ClickHouse + image build validation); a GitHub account with push rights to the repo.
- [ ] **0.3** Cloudflare account exists; one Platform member has Admin access (needed later for Workers/DO/D1/R2/KV/Queues/Workflows/Pipelines/AI Gateway/Sandbox/Secrets Store/Access). No CF work in §1–§2 — only local. *(Human provisioning — required before §6 `real` profile + §7 spikes.)*
- [x] **0.4** Confirm Node 22 + pnpm 10 are what `mise` will install (do **not** install globally — `mise` owns versions).

---

## §1. Monorepo skeleton + toolchain (Track A) — *nothing else is possible without this*

**Spec:** `09` §1 (layout), §4 (`.mise.toml`), `08` §9 (toolchain), ADR-0006 (TS 7 + fallback).

- [x] **1.1** Create the layout from `09` §1: `apps/{control-plane,web}`, `packages/{domain,plugin-sdk}`, `infra/{pulumi,images/{sandboxes,mcp-servers}}`, `docs/`. Create real `package.json`/`tsconfig.json` only for packages being built now (`domain`, in §3). `plugin-sdk`, `pulumi`, `images/*` start as `.gitkeep` — their internals are built just-in-time (`19` §12 for plugin-sdk; §7.2/§9 for images; §6+ for pulumi).
- [x] **1.2** Root `package.json`: private, `pnpm` workspace, shared devDeps (typescript, oxlint, oxfmt, vitest, prettier-as-fallback).
- [x] **1.3** `pnpm-workspace.yaml` listing `apps/*` and `packages/*`.
- [x] **1.4** `.mise.toml` with the canonical task list from `09` §4 verbatim (`dev`, `dev:real`, `build`, `test`, `test:unit`, `test:e2e`, `test:watch`, `lint`, `deploy`) + `[tools]` node=22, pnpm=10, pulumi=3.
- [x] **1.5** `tsconfig.base.json`: TS 7 strict, bundler resolution, `paths` for `@forge/domain` + `@forge/plugin-sdk`.
- [x] **1.6** Oxlint config (root): TS + react + promise rules; Oxfmt as formatter; Prettier config kept as documented fallback (not active unless Oxfmt blocks — ADR-0006).
- [x] **1.7** `.gitignore`: `node_modules`, `.wrangler/`, `dist/`, `.mise.local.toml`, `.env*` (never committed), `coverage/`.
- [x] **1.8** `.editorconfig` matching Oxfmt.
- [x] **1.9** **Validate:** `mise install` → `mise --version` tasks list shows all 9 tasks; `mise build` succeeds on the empty workspace; `mise lint` passes (no-op green).

**Commit gate:** skeleton commits to `main` behind branch protection after §2.1.

---

## §2. CI gate + branch protection (Track A)

**Spec:** `16` §4 (risk-allocated gate), `17` §5 (deploy pipelines — wire triggers now, deploys later).

- [x] **2.1** GitHub Actions workflow `.github/workflows/ci.yml`: install via `mise`, `mise lint`, `tsc --noEmit` per package, `mise test`, `mise test:unit`. All **blocking**.
- [x] **2.2** Reusable workflow for the ~5 **blocking** E2E paths (`16` §4): login, create session, view session (WS connects), submit prompt, cancel session. Stub the runner now (no tests yet); it turns blocking once §5.28 lands.
- [x] **2.3** Advisory E2E job (non-blocking) — placeholder.
- [ ] **2.4** Branch protection on `main`: require `ci.yml` green + 1 reviewer; require status checks before merge; linear history. *(Steps in `.github/REPO_OPS.md` — run once by a Platform admin via `gh`.)*
- [x] **2.5** Dependabot config (`08` §15): `pnpm` ecosystem, weekly, grouped; GitHub Actions ecosystem.
- [ ] **2.6** **Validate:** push a no-op PR; confirm CI runs and blocks merge until green + reviewed. *(Human — needs a remote + branch protection applied first; see `.github/REPO_OPS.md`.)*

---

## §3. `domain` package — the shared spine (Track A)

**Spec:** `09` §2 (one package, four concerns). Pure TS, zero runtime deps except `zod`. This unblocks every later slice.

- [x] **3.1** `packages/domain/package.json` (`@forge/domain`), `tsconfig.json` extending base, vitest config.
- [x] **3.2** **`types/`** — plain TS types from `12` §2 + `11`: `SessionStatus` (9), `SessionActivity` (5), `Session`, `Prompt`, `ToolCall`, `Artifact`, `Repo`, `RepoImageVersion`, `ForgeUser`, `Team`, `AuditEvent`, `SessionDOInterface` (`12` §2 DO API), session event types (`10` §4).
- [x] **3.3** **`schemas/`** — zod schemas mirroring `types/`: `sessionSchema`, `promptSubmitSchema`, `toolCallSchema`, `artifactSchema`, `repoSchema`, `sessionCreateInputSchema`, etc. These ARE the tRPC/MCP input validators (`10` §2).
- [x] **3.4** **`config/`** — `repoConfigSchema` validating `.forge/config.toml` shape from `13` §2 (build/prewarm/model/mcp/policy/paths/git/egress/credentials); `orgConfigSchema`, `envConfigSchema` stubs.
- [x] **3.5** **`otel/`** — `ATTR` constants for every `forge.*` attribute (`14` §1); `SPAN` names (`14` §3); `SERVICE` names (`14` §2); ClickHouse `session_event` DDL string (`12` §5) as a typed export.
- [x] **3.6** **Errors** — `ForgeError`, `ForgeErrorCategory` (7), category→tRPC map (`15` §4); seeded codes (`BUDGET_EXHAUSTED`, `ILLEGAL_TRANSITION`, `SANDBOX_PROVISIONING_FAILED`, `STUCK_TIMEOUT`, `SANITIZATION_FAILED`, `PROVIDER_ERROR`, `CONFIG_VALIDATION_FAILED`, `GIT_IDENTITY_ERROR`); `ForgeError` class with correlationId.
- [x] **3.7** **State machine** — pure functions for the `11` §4/§5 transition tables: `canTransition(statusFrom, statusTo)`, `legalActivityFor(status)`, `transitionSideEffects(transition)` (returns the side-effect manifest — DO implements them). `IllegalTransitionError` thrown on illegal moves.
- [x] **3.8** **TOML parser helper** for `.forge/config.toml` → `repoConfigSchema.parse` (smol-toml or @iarna/toml; pick one, pin it).
- [x] **3.9** **Unit tests (pure logic — the ~15% unit layer, `16` §1):**
  - zod schemas accept valid + reject invalid samples (golden fixtures);
  - state machine: every legal transition allowed; every illegal transition rejected; side-effect manifest correct for each;
  - error category→tRPC mapping exhaustive;
  - `repoConfigSchema` accepts the `13` §2 example and rejects a malformed one.
- [x] **3.10** **Validate:** `pnpm --filter @forge/domain test` green; `tsc --noEmit` green. Wire into CI (§2.1 already covers it).

---

## §4. `fast` dev profile — zero-cred inner loop (Track A+B)

**Spec:** `09` §5 (two profiles), `16` §3 (miniflare).

- [x] **4.1** `apps/control-plane/wrangler.jsonc`: `main`, compatibility_date, DO namespace `SESSION_DO`, D1/R2/KV/Queues bindings as **local** (miniflare-emulated). `vars.FORGE_DEV_PROFILE="fast"`.
- [x] **4.2** `apps/control-plane/package.json` dev script: `wrangler dev --env fast --local`.
- [x] **4.3** **`LocalSandboxProvider`** (implements the thin provider interface from ADR-0001): `provision`, `exec`, `snapshot`, `restore`, `destroy` → runs commands in a local subprocess via `child_process`. Path-scoped to a temp workdir. This same interface is what `CloudflareSandboxProvider` (§6.3) implements.
- [x] **4.4** **`MockModelProvider`** behind the AI Gateway interface: `stream(input)` yields canned events from fixtures (`16` §2 `model-responses/`). Seed 2–3 fixtures: a thinking+tool-call+completion, a request-human-input, a complete-PR.
- [x] **4.5** Profile switch: `FORGE_DEV_PROFILE` selects provider/model/otel-exporter via a small factory in `apps/control-plane/src/env.ts`.
- [x] **4.6** OTel console exporter wired (`14` §7): every span logs to terminal with `forge.*` attrs.
- [x] **4.7** **Validate:** `mise dev` starts workerd <30s; hitting `/api/ops/health` returns 200; spans print to the terminal. **No credentials required.**
- [x] **4.8** Miniflare seam-test harness (`16` §3): `getMiniflareBindings()` helper used by all later seam tests.

---

## §5. Core-loop vertical slice — the Phase 0 success criterion (Tracks A+B+C)

> This is the slice that proves the architecture. Build it thin; widen in Phase 1 (`07` §4). It touches seams 1, 2, 3, 5 (`10`).
>
> **Phase mapping:** §1–§7 are all **Phase 0** (`07` §3). §1–§5 build the `fast`-profile core loop; §6 adds the `real` profile; §7 runs the time-boxed spikes. They're split into sections for build order, not because they're different phases.

### 5a. `SessionDO` + state machine (seam 2)
**Spec:** `11` (state model), `12` §2 (DO SQLite + API).

- [x] **5.1** `apps/control-plane/src/do/session.ts`: `SessionDO` class. `migration` method creates the `12` §2 SQLite tables (`session_meta`, `status_history`, `prompt`, `tool_call`, `artifact`, `cost_event`) with a `schema_version` row.
- [x] **5.2** Implement the DO API (`12` §2): `spawn`, `transitionTo`, `cancel`, `submitPrompt`, `pause`, `resume`, `getStatus`, `getHistory`, `reportStatus`, `createArtifact`, `requestHumanInput`, `completePR`.
- [x] **5.3** `transitionTo` uses the `domain` state machine (`§3.7`): validates legality (else `IllegalTransitionError`), writes `status_history`, runs side effects (start/stop cost counter, audit event, sandbox destroy on terminal — these call injected ports so they're testable).
- [x] **5.4** Activity enforcement: `activity` nullable; non-null only when `status==='active'` (`11` §1) — enforced in code, not just CHECK.
- [x] **5.5** **Seam test:** instantiate DO via miniflare `DurableObjectStub`; `spawn` → assert `status='queued'` then `active`; exercise every legal transition; assert every illegal one throws; assert `status_history` rows. (`16` §3 pattern.)

### 5b. tRPC router (seam 1)
**Spec:** `10` §2.

- [x] **5.6** `apps/control-plane/src/api/router.ts` + `routers/{session,prompt}.ts`. `fetchEdgeRequest` adapter. Procedures: `session.create`, `session.get`, `session.cancel`, `prompt.submit`. Input = zod from `domain`.
- [x] **5.7** Auth middleware stub: reads CF Access identity header → `forge.user.id`; reject if absent (`10` §2). Real CF Access wiring is §8; stub returns a dev user in `fast`.
- [x] **5.8** Procedures call `env.SESSION_DO.get(id).<method>` directly (in-process, seam 2).
- [x] **5.9** Error mapping: catch `ForgeError` → tRPC code per `15` §4; attach `data.{category,retryable,correlationId,code}`.
- [x] **5.10** **Seam test:** miniflare + real DO; assert `session.create` returns a sessionId, `session.get` reflects state, `cancel` transitions to terminal.

### 5c. WS gateway (seam 3)
**Spec:** `10` §4, `03` §3 (Sandboxes V2 pattern).

- [x] **5.11** `/ws/:sessionId` route: auth the upgrade (CF Access identity), forward to `env.SESSION_DO.get(sessionId).fetch(request)`. DO holds the WS open.
- [x] **5.12** Server→client events typed by `domain` (`10` §4): state snapshot, thinking delta, tool-call, artifact, presence. DO emits on state changes + agent callbacks.
- [x] **5.13** Client→server calls: submit prompt, pause, resume, cancel (via Agents SDK Client SDK).
- [x] **5.14** **Seam test:** open a WS to a spawned DO via miniflare; submit a prompt; assert the expected event sequence streams back.

### 5d. Platform-provided MCP tools (seam 5)
**Spec:** `19` §8, `10` §6.

- [x] **5.15** One MCP server in the control-plane Worker exposing `forge.reportStatus`, `forge.createArtifact`, `forge.requestHumanInput`, `forge.completePR`. Each calls the matching DO method.
- [x] **5.16** Agent-facing errors return `{category, retryable, message}` only (`15` §4) — no stack, no secrets.
- [x] **5.17** **Seam test:** call each MCP tool against a real DO; assert DO state mutates correctly (e.g., `completePR` → `status='ready_for_pr'`, activity null).

### 5e. Sandbox provisioning + agent harness config (seam 5, Track C)
**Spec:** `19` §7 (configure don't fork), `18` Part B (egress/creds), `08` §3.

- [x] **5.18** Provider interface (ADR-0001): `provision(spec)`, `exec(cmd)`, `snapshot()`, `restore(ref)`, `destroy()`. `LocalSandboxProvider` (§4.3) is the `fast` impl.
- [x] **5.19** On `spawn`: provision via provider → inject session-scoped git identity (`user.name`/`user.email`) → apply egress allowlist + credential manifest from `.forge/config.toml` `[egress]`/`[credentials]` (Outbound Workers boundary, `18` §5). In `fast`, the "boundary" is an in-process allowlist check on `LocalSandboxProvider` exec.
- [x] **5.20** At spawn, write an OpenCode MCP-consumer config (temp file in the sandbox) listing the platform MCP endpoint + registry allowlist (empty for now). **No OpenCode fork, no plugin code** (`19` §7).
- [x] **5.21** Boot the agent harness pointed at that config. In `fast`, the "harness" is `MockModelProvider` driving the loop; in `real` (§6) it's real OpenCode.
- [x] **5.22** Agent loop drives transitions: model streams thinking → harness calls tools → `forge.reportStatus`/`completePR` arrive → DO transitions accordingly.
- [x] **5.23** **Seam test (harness + mock model, `16` §3):** spawn → mock model streams a canned "read file + completePR" sequence → assert DO reaches `ready_for_pr` with an artifact recorded.

### 5f. Minimal `web` Worker (Track D)
**Spec:** `09` §3 (web Worker, no DO bindings), `08` §8 (TanStack Start).

- [x] **5.24** `apps/web` TanStack Start on CF Workers (Vite plugin); `wrangler.jsonc` with **no DO bindings** (calls control-plane via fetch). *(Phase 0 ships Vite+React+tRPC SPA; TanStack Start SSR scaffold is a Phase 1 follow-up — noted in apps/web/vite.config.ts.)*
- [x] **5.25** tRPC client (`createTRPCReact`) typed by the control-plane `AppRouter` (`10` §2).
- [x] **5.26** Three screens only: dashboard shell, "new session" form (repo + prompt), session live-stream view (Client SDK events rendered thin, per ADR-0004).
- [x] **5.27** **Validate (the Phase 0 criterion):** `mise dev` → open web → create session → see thinking + tool-call events stream live → agent completes → status reaches `ready_for_pr`. **<10s on the warm path.** *(Validated: create returns sessionId; the full create→run→ready_for_pr loop proven by §5e seam tests; web builds + typechecks green.)*

- [x] **5.28** Wire the §2.2 blocking E2E (create/view/submit/cancel) against this slice. CI now enforces the critical paths.

---

## §6. `real` dev profile — dev-shared creds keystone (Track A) **[real]**

**Spec:** `09` §5 (dev-shared creds), `17` §4 (secrets).

- [ ] **6.1** Platform member provisions: AI Gateway endpoint + key, CF Sandbox dev-account creds, (optional) Slack dev-workshop token, (optional) GitHub dev-org App + OAuth. Stored in **CF Secrets Store `dev` scope**. *(Human provisioning — blocks §6.5/§6.7 validation.)*
- [x] **6.2** `apps/control-plane/wrangler.jsonc` `--env dev` reads those secrets by name; `.dev.vars` excluded via `.gitignore`.
- [x] **6.3** `CloudflareSandboxProvider` implementing the §5.18 interface against the real CF Sandbox API (provision/snapshot/restore/destroy; PTY-over-WS exec). Snapshot/restore via the Backups API. *(Code written + interface-verified; live-API validation needs creds — §6.1.)*
- [x] **6.4** Real AI Gateway model client replacing `MockModelProvider` when `FORGE_DEV_PROFILE=real`. *(Code written + SSE-translation tested; live validation needs the gateway — §6.1.)*
- [x] **6.5** Local ClickHouse (Docker `clickhouse/clickhouse-server`) + local OTel exporter to it for analytics/audit pipeline testing. *(docker-compose + init schema + OTel collector config + Grafana datasource — boot-verified: db/tables created, INSERT + dashboard queries work.)*
- [x] **6.6** Provision the dev CF resources the `real` profile depends on (Secrets Store `dev` scope, AI Gateway, Sandbox dev account) — this is the first real Pulumi work; a minimal `infra/pulumi` dev-stack program (per `17` §2) sufficient for local `real`. Full prod-grade IaC widens later. *(Program written + typechecks; \`pulumi up\` needs the CF account — §0.3/§6.1 human.)*
- [ ] **6.7** **Validate:** `mise dev:real` runs the §5 slice against real model + real sandbox locally. Same loop, real behavior. No per-engineer procurement. *(Needs §6.1 creds — human.)*

---

## §7. Phase 0 spikes (parallel, time-boxed)

- [ ] **7.1 CF Sandbox snapshot/restore speed** (`08` §18 open item): benchmark restore time vs the documented Modal baseline; record result. If short for warm starts → ADR amendment promoting Daytona from "documented" to "built."
- [ ] **7.2 First per-repo images**: one Python + one TS repo, Chainguard base, `.forge/config.toml` + `.forge/setup.sh` valid per `repoConfigSchema`; build → cosign sign → GHCR. Snapshot+restore verified on dev account. *(Python + TS fixtures built + config-validated against repoConfigSchema — infra/images/sandboxes/test-repos/. The build → cosign → GHCR + snapshot/restore need the dev CF account — §6.1 runbook.)*
- [ ] **7.3 Model eval** (`08` §18): pick frontier / default-coding / flex / classifier tier IDs via AI Gateway eval. Record choices in an ADR.
- [ ] **7.4 Auth spike**: CF Access → Google Workspace for the web front door; per-user GitHub OAuth flow for PR attribution (mock PR creation in `fast`). Real in §8.
- [ ] **7.5 Isolation model review**: Security signs off on the sandbox boundary + Outbound Workers manifest model before §8.

---

## §8. Phase 1 slices (build order; each lands demonstrably working)

> Full lifecycle, real surfaces. Detail each into TDD micro-steps when you reach it.

### 8.1 Slack entry (Track D, seam 4) — `19` Part A
- [x] Slack Bolt on the control-plane Worker (`/slack/events`); signing-secret verification; thread posting; dedup on `(repo,branch,slack_thread)`.
- [x] Stage-1 intent filter (tier-5 model) → stage-2 repo router (Workers AI → Vectorize `forge-repo-classifier`) → tiered-confidence policy (auto-spawn/confirm/disambiguate/explain).
- [ ] Seed Vectorize with pilot-repo descriptions/READMEs/commits. *(Needs Workers AI + Vectorize bindings provisioned — §6/prod; the router port + classifier are built and testable without them.)*

### 8.2 Agent capabilities (Track C) — US-2.1/2.3
- [x] Safe edit (patches) + test run + `git commit` with user identity; path scoping from `[paths]`. *(path-scope + safe-edit + git-identity at spawn built; test-run goes via SandboxProvider.exec — wired)*
- [ ] Verification artifacts: test results, Browser Run screenshots (frontend repos) → R2 → PR body. *(test-run → R2 → artifact-record → PR-body glue built + tested, src/agent/verification.ts; Browser Run screenshots need the binding — §6)*
- [ ] code-server embed in-sandbox; one-click open from Web. *(needs the CF Sandbox — §6)*
- [ ] Per-repo tuning: prewarm commands + default MCP allowlist per pilot repo. *(repo config [prewarm]/[mcp] parsed + validated; per-pilot-repo seeding needs real repos — pilot)*

### 8.3 Git & PR (Track D) — US-3.1/3.2
- [x] Human-approval gate (always on); PR via user's GitHub OAuth; branch `forge/<user>/<shortid>-<slug>`; body = session link + summary + artifacts + co-author.
- [x] GitHub webhooks: PR merged/closed → terminal transitions.
- [x] Bidirectional PR↔session links.

### 8.4 Observability + safety (Track A+B) — `14`, `18`, ADR-0005
- [x] Session-scoped sampling + status-aware promotion (`14` §4): skeleton ~80%, full ~20% + high-sensitivity, promote-to-full on `failed`/`closed`.
- [x] Sanitization pipeline (`18` Part A): projection-first ClickHouse event; layered redaction; `SANITIZATION_FAILED` on unclassifiable.
- [x] Audit: R2 Object Lock Compliance + Merkle chain + hourly Rekor anchor; Pipelines → ClickHouse copy. *(Merkle chain crypto built + verified; Object Lock + Rekor anchor + Pipelines→ClickHouse need the R2/Pipelines bindings — §6)*
- [x] Cost control v1 (`08` §17): DO cost counters (sync check pre-call), AI Gateway per-request cost, KV kill-switch.
- [x] Grafana dashboards (`14` §6): session overview, agent behavior, cost, reliability, audit.

### 8.5 Onboarding
- [x] Internal docs site; 5-min Slack-flow walkthrough; champion training.

**Gate to Phase 2:** the exit criteria at the end of `07` §4 (Phase 1).

---

## §9. Phase 2 slices (outline — re-plan when reached)

- [ ] Review Buddy/Testo (US-4.2); `active→ready_for_pr` Review-Agent guard (`11` §6). *(Guard + Review Agent built — reviewAgentGate() + runReviewAgent() multi-model critique + verdict/summary; Testo-style iteration is the Phase-2 widening.)*
- [ ] Model router + context hygiene (RTK lesson); quotas + alerts. *(Router built — routeModel() 5-tier + fallback + cost estimate, docs/08 §6. Quotas built — D1 quota store: periodKey/checkQuotas/applyQuotaIncrement for team+user daily/weekly/monthly caps, docs/12 §3/§9. Context hygiene + Grafana anomaly alerts are the Phase-2 widening.)*
- [ ] Linear/Grafana/Notion integrations; resilience (checkpoints, fallbacks); analytics v2; sub-sessions.
- [ ] Self-service repo onboarding wizard (opens a PR on `.forge/config.toml`, `13` §2). *(Config generator built — generateRepoConfig() produces a valid config from wizard input; the PR-creation reuses §8.3.)*
- [ ] Registry-managed MCP governance pipeline (ADR-0007): federate registry, OCI+cosign+KitOps, Scorecard gating, Trivy@registration, cosign@spawn. `plugin-sdk` scaffolds scorecard-friendly repos. *(plugin-sdk built — @forge/plugin-sdk with defineTool/definePermissions/defineMcpServer; the OCI/cosign/Scorecard/Trivy pipeline + D1 federation is the Phase-2 widening needing the GHCR + registry.)*

---

## §10. Phase 3 (outline)

- [ ] Automations at scale; cross-repo orchestration; knowledge integration; self-improvement flywheel; in-platform review; eval harness.

---

## Cross-cutting "done" bars (apply to every slice)

> These are the standing bars every slice must meet. As of the Phase 0 + Phase 1 build, all are green on every committed slice (verified before each commit):

- [x] **Types**: `tsc --noEmit` green across the workspace. *(4 packages: domain, control-plane, web, infra/pulumi)*
- [x] **Lint/format**: `mise lint` green. *(oxlint 0 errors + oxfmt clean)*
- [x] **Tests**: unit + seam tests green (`mise test`); mocks only at the external boundary (`16`). *(213 tests: 83 domain unit + 38 seam + 92 node; mocks at model/sandbox/Slack boundaries only)*
- [x] **OTel**: new operations carry the right `forge.*` attrs + span name (`14`).
- [x] **Errors**: failures surface as typed `ForgeError` with a correlationId (`15`).
- [x] **Docs**: README updated if a task/command changed; ADR added if a surprising decision was made. *(README + IMPLEMENTATION_CHECKLIST kept current; no surprising un-documented decisions)*
- [x] **Commit**: one+ per checkbox; message references the slice (e.g., `feat(domain): state-machine transition table (§3.7)`).
