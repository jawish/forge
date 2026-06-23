# Forge Implementation Roadmap
**Status**: Authoritative for *what to build and in what order*. Aligned with the locked specs (`08`–`19`) and the ADRs.  
**Timeline**: 6-month horizon to broad internal availability. Phased for learning + de-risking.  
**Team Model**: Platform (core infra + control plane + MCP tools) + embedded eng from pilot repos (image tuning) + Security review at each gate.

> **How this doc fits in.** This roadmap is the **engineering execution track** (vertical slices, in build order). It carries the *decisions* from the locked specs (`08`–`19`) forward into *sequence*.
> - For *what* a thing is: `CONTEXT.md`, `08`–`19`.  
> - For *why* a choice: `docs/adr/`.  
> - For *step-by-step build instructions with checkboxes*: `IMPLEMENTATION_CHECKLIST.md` (root).

---

## 1. Guiding principles (how we sequence)

1. **Inside-out foundation, then thin vertical slices.** Land the toolchain, the `domain` package, and the `fast` dev profile *before* any feature. Nothing else is reliable without them.
2. **Each slice is demonstrably working software**, crossing all the seams it touches, with a test at each seam. We never accumulate "almost-works" layers.
3. **The docs already prescribe the hard parts.** `09` gives the exact `.mise.toml`; `11` gives the exact transition table; `12` gives the exact DDL; `16` gives the exact test shape. Follow them literally — don't re-derive.
4. **`fast` first, `real` second.** Every slice is built and tested against the `fast` profile (mocks, zero creds, <30s start). Only the slices that *require* real model/sandbox behavior move to `real`.
5. **Defer by ADR, not by forgetting.** Anything in `08` §18 ("open items") or a doc's "what this does NOT specify" is deliberately deferred and tracked, not silently dropped.
6. **DRY, YAGNI, no speculative abstraction.** Build the seam that's in front of you. The thin sandbox-provider interface earns its keep twice (failover + local mock) — that's *why* it's allowed; one-use abstractions are not.

---

## 2. Build tracks (the decomposition)

Work decomposes into four parallel-ish tracks once the foundation is in place. Tracks are not phases — they're *concerns*. A vertical slice usually touches one track and a seam or two.

| Track | Owns | Seams (`10`) | Spec homes |
|---|---|---|---|
| **A. Foundation** | toolchain, `domain`, dev profiles, CI, OTel, errors | — | `09`, `13`–`16` |
| **B. Control plane** | `control-plane` Worker, `SessionDO`, tRPC router, WS gateway (server side) | 1, 2, 3, 6 | `10`, `11`, `12` |
| **C. Sandbox & agent** | provider interface, CF Sandbox + Local, OpenCode config, platform MCPs (server side) | 5 | `08` §3/§7, `19` |
| **D. Surfaces & integrations** | `web` (TanStack Start + the seam-3 browser client), Slack bot, GitHub App/OAuth, classifier, audit/sanitization | 3 (client), 4 | `04`, `19`, `18` |

---

## 3. Phase 0 — Foundations & Spikes (Weeks 1–3)

**Goal**: Validate the technical choices, unblock parallel work, and **prove the core loop on 1 repo end-to-end against the `fast` profile**, then the `real` profile. Everything later depends on Phase 0 landing clean.

**Definition of done (all must be tickable):**

### 3.1 Foundation (Track A) — the non-negotiable first week
- [ ] Monorepo skeleton matching `09` §1 exactly: `apps/{control-plane,web}`, `packages/{domain,plugin-sdk}`, `infra/{pulumi,images}`, `docs/`.
- [ ] `mise` toolchain (`.mise.toml`) with the canonical tasks from `09` §4: `dev`, `dev:real`, `build`, `test`, `test:unit`, `test:e2e`, `test:watch`, `lint`, `deploy`. Node 22, pnpm 10, Pulumi 3.
- [ ] TS 7 (RC) primary + TS 6 fallback path pinned (`08` §9, ADR-0006); `tsconfig.base.json` strict; Oxlint + Oxfmt (Prettier fallback) wired.
- [ ] pnpm workspace + workspace-protocol imports; `pnpm -r` task graph works.
- [ ] **CI pipeline** (GitHub Actions) implementing the risk-allocated gate from `16` §4: `tsc` + Oxlint + unit + seam tests **blocking**; ~5 critical E2E **blocking**; rest advisory. Branch protection: green gate + 1 reviewer.
- [ ] **OTel foundation**: `forge.*` attribute namespace, service names, span names from `14` §1–§3; console exporter locally; sampling-token helper stubbed (full promotion logic lands with the core loop).
- [ ] **Error model**: `ForgeError` contract + 7 categories + category→tRPC mapping from `15` §1–§4; seeded domain codes.
- [ ] **`domain` package** (one package, four concerns per `09` §2): `types/`, `schemas/` (zod), `otel/`, `config/` (`repoConfigSchema` etc. from `13`). Pure TS, fully unit-tested. This is the spine — every later slice imports from it.

### 3.2 `fast` dev profile (Track A + B) — the zero-cred inner loop
- [ ] `wrangler dev` (workerd) for `control-plane` with miniflare-emulated D1/R2/KV/Queues/DO SQLite (`16` §3).
- [ ] **`LocalSandboxProvider`** implementing the thin provider interface (ADR-0001) — runs commands in a local subprocess. Same interface the real CF Sandbox will use.
- [ ] **`MockModelProvider`** behind the AI Gateway interface — canned streaming fixtures for UI/loop work.
- [ ] `mise dev` = `FORGE_DEV_PROFILE=fast pnpm -r --parallel dev`. **Validated: <30s cold start, zero credentials required.**

### 3.3 Core-loop vertical slice (Tracks A+B+C, seams 1+2+3+5) — the Phase 0 success criterion
The Phase 0 success criterion is *"prompt in Web/Slack → sandbox boots → OpenCode runs `rg` + `git status` → streams result back, <10s warm."* This slice is that criterion, built thin:

- [ ] `SessionDO` skeleton with the **2-field state model** (`11`): `status` (9) + `activity` (5), the full transition table with guards + side effects, `IllegalTransitionError`. DO SQLite schema from `12` §2 with code-level migrations.
- [ ] **Seam 1** (tRPC v11, `fetchEdgeRequest`): `session.create`, `session.get`, `session.cancel`, `prompt.submit`. Input = zod from `domain`.
- [ ] **Seam 2** (in-process DO calls): the `SessionDO` API surface from `12` §2.
- [ ] **Seam 3** (Agents SDK Client SDK over `/ws/:sessionId`): state snapshots + thinking/tool-call/artifact/presence events; browser goes Worker→DO per the CF constraint.
- [ ] **Seam 5** (platform-provided MCP tools): `forge.reportStatus`, `forge.createArtifact`, `forge.requestHumanInput`, `forge.completePR` — implemented as one MCP server in the control-plane Worker, calling DO methods.
- [ ] **Sandbox provisioning** via the provider interface: spawn → inject short-TTL session-scoped git identity + egress allowlist (Outbound Workers boundary contract, `18` Part B) → boot agent.
- [ ] **Agent harness config** (`19` §7): at spawn, write an OpenCode MCP-consumer config listing platform MCPs + (for now) an empty registry allowlist. **No OpenCode fork.**
- [ ] Minimal `web` Worker (TanStack Start) shell: "new session" → live stream view. Just enough to drive and observe the loop.
- [ ] **Tested at every seam** per `16`: seam tests (real DO via miniflare, mocked externals at the boundary); harness+mock-model tests with canned fixtures.

### 3.4 Spikes (parallel, time-boxed)
- [ ] **CF Sandbox snapshot/restore speed** — open item `08` §18. Measure restore vs the Modal baseline the docs reference. If it falls short for warm starts, promote the Daytona failover from "documented" to "built."
- [ ] **First per-repo image** (one Python, one TS) on Chainguard base; `.forge/config.toml` + `.forge/setup.sh` validated by `repoConfigSchema`; image build → cosign sign → GHCR. Snapshot+restore working on the dev account.
- [ ] **Model eval for tier IDs** — open item `08` §18 (tier *structure* locked; *IDs* not). Pick frontier/default-coding/flex/classifier IDs for the eval via AI Gateway.
- [ ] **Auth spike**: CF Access → Google Workspace (web front door) + per-user GitHub OAuth for PR attribution (mock PR creation in `fast`).

### 3.5 `real` dev profile (Track A) — dev-shared creds keystone
- [ ] One platform member provisions dev-shared keys (AI Gateway, CF Sandbox dev account, optional dev Slack workspace + dev GitHub org) into **CF Secrets Store `dev` scope**.
- [ ] `wrangler dev --env dev` reads them automatically; `mise dev:real` = `FORGE_DEV_PROFILE=real ...`.
- [ ] Local ClickHouse (Docker) + console OTel for analytics/audit pipeline testing without ClickHouse Cloud.
- [ ] **Validated: same core loop runs against real model + real CF Sandbox locally, no per-engineer procurement.**

**Phase 0 exit gate**: §3.3's slice works on `fast` (<10s warm) AND `real`; §3.1/§3.2/§3.5 tooling is green and documented in the root README; spike results recorded as ADRs/notes. Security review sign-off on the isolation model.

---

## 4. Phase 1 — MVP Pilot (Weeks 4–10)

**Goal**: Production-usable on 3 pilot repos (1 backend/monolith, 1 frontend/TS, 1 infra). Dogfood + measure. 50–200 real sessions.

Each item is a vertical slice that lands demonstrably working. Build order within the phase:

### 4.1 Full session lifecycle (Track B+D)
- [ ] **Slack bot** (Slack Bolt on the control-plane Worker, seam 4): Events API ingestion + signing-secret verification; thread posting; dedup on `(repo, branch, slack_thread)`.
- [ ] **Two-stage classifier** (`19` Part A): stage-1 intent filter (tier-5 model) → stage-2 repo router (Workers AI embeddings → Vectorize) → tiered-confidence policy (auto-spawn / confirm / disambiguate / explain). Vectorize index `forge-repo-classifier` seeded for pilot repos.
- [ ] **Web session creation** (US-1.2): repo picker, prompt composer, templates. tRPC `session.create`.
- [ ] **Multiplayer basic** (US-1.4): presence + attributed prompts via the Client SDK.
- [ ] **Full state machine** wired to real side effects: Slack thread updates on every transition, audit events, sandbox destroy on terminal.

### 4.2 Agent capabilities (Track C)
- [ ] **Safe edit + test run + git commit** with user identity (`git config` per session; no shared bot identity). Path scoping from `.forge/config.toml` `[paths]`.
- [ ] **Verification artifacts** (US-2.3): test results, screenshots (Browser Run for frontend repos) → R2 → linked in PR body.
- [ ] **code-server embed** (US-2.2) in the same sandbox; one-click open from Web.
- [ ] **Per-repo tuning**: images with prewarm for each pilot repo; default tools/MCP allowlist from config.

### 4.3 Git & PR (Track D)
- [ ] **PR creation with user OAuth** (US-3.1): branch `forge/<user>/<shortid>-<slug>`; human-approval gate (always on); PR body = session link + summary + artifacts + "Co-authored-by: Forge Agent". Branch protection + CI never bypassed.
- [ ] **GitHub webhooks** (seam 4): PR merged/closed → `pr_open → merged|closed` transitions.
- [ ] **Bidirectional links** (US-3.2): PR ↔ session replay.

### 4.4 Observability + safety (Track A+B)
- [ ] **Full tracing** on the critical path with the `forge.*` namespace; session-scoped sampling + status-aware promotion implemented (`14` §4): skeleton for ~80%, full for ~20% + high-sensitivity repos, promote-to-full on `failed`/`closed`.
- [ ] **Sanitization pipeline** (`18` Part A): projection-first ClickHouse event; layered redaction on the few included content fields; `SANITIZATION_FAILED` on unclassifiable values. Runs at the DO→Pipelines write.
- [ ] **Audit trail**: R2 Object Lock (Compliance) + Merkle chain + hourly Rekor anchor (`08` §5, ADR-0005); Pipelines → ClickHouse queryable copy.
- [ ] **Cost control v1** (`08` §17): DO SQLite cost counters checked synchronously before each model call; AI Gateway per-request cost; KV kill-switch.
- [ ] **Dashboards** (Grafana on ClickHouse): session overview, agent behavior, cost, reliability, audit (`14` §6).
- [ ] **Basic analytics**: session list, conversion funnel, cost/session.

### 4.5 Onboarding
- [ ] Internal docs site; 5-min walkthrough of the Slack flow; champion training.

**Gates to Phase 2**: >30% pilot sessions → merged PR (or clean no-change); champion NPS >40 or "would use daily"; P95 warm start <4s; no critical security/data incidents in 100+ sessions; cost per successful outcome under threshold; Security sign-off.

---

## 5. Phase 2 — Hardening + Review Agents (Weeks 11–16)

**Goal**: Reliable for 20–30% org rollout. Add review agents, cost controls, deeper integrations.

- [ ] **Review Buddy / Testo** (US-4.2): multi-model critique of diffs; configurable per repo (the `active → ready_for_pr` Review-Agent guard from `11` §6).
- [ ] **Model router** (`05` §3.1): classifier + defaults + flex for background; context-hygiene rules enforced + monitored (RTK lesson applied — no command-rewriting wrappers).
- [ ] **Quotas + alerts** (`08` §17): per-team daily/weekly D1 quota store; ClickHouse→Grafana anomaly alerts.
- [ ] **Deeper integrations**: Linear issue sync; Grafana/ClickHouse alert → auto-session (deduped); Notion context pull.
- [ ] **Resilience** (US-6.2): checkpoints/resume in DO, fallback models, circuit breakers, recovery UX.
- [ ] **Analytics v2**: failure taxonomy, per-repo perf/cost, MCP-usage queries, exportable datasets.
- [ ] **Polish**: diff viewer, screenshot carousel, cost estimate in composer, mobile Web.
- [ ] **Sub-session spawning + monitoring** (US-1.3).
- [ ] **Self-service repo onboarding** (US-0.3): Web wizard that opens a PR editing `.forge/config.toml` (`13` §2).
- [ ] **Registry-managed MCP governance** (`19` Part B, ADR-0007): federate official MCP Registry → D1; OCI+cosign+KitOps in GHCR; per-repo enable list; Scorecard gating; Trivy at registration; cosign verify at spawn. `plugin-sdk` scaffolds scorecard-friendly repos.

**Gates to broad availability**: 40%+ weekly active eng in enabled repos; <5% sessions need significant rework; cost scaling sub-linear; zero P1 incidents; compliance audit passed; eval harness started.

---

## 6. Phase 3 — Agentic Factory Expansion (Months 5–6+)

**Goal**: From "coding agent" to broader software factory with self-improving elements.

- [ ] **Automations at scale**: more triggers (GitHub events, planning tools), priority routing (incident fast path), structured handoff between specialized agents.
- [ ] **Cross-repo orchestration**: parent sessions coordinating sub-sessions; dependency-graph awareness (later).
- [ ] **Knowledge integration**: Linear/Notion/Slack history → "coworker who knows."
- [ ] **Self-improvement**: data flywheel → prompt/tool/router/image tuning suggestions; safe A/B of new defaults.
- [ ] **In-platform diff review/approve** (human gate + CI preserved); richer PR simulation.
- [ ] Visual: code-server + Browser Run + Stagehand cover v1 (`08` §12). VNC only if a non-browser GUI use case (Electron/desktop) surfaces.

---

## 7. Resource & risk plan

**Team**: Core Platform 3–4 eng (infra, agent runtime, integrations, analytics) + 1 PM/Designer; 1–2 embedded per pilot repo; Security/Compliance at Phase 0/1 gates; Platform on-call + `#forge-support`.

**Budget**: Cloudflare (Workers/DO/Sandbox/R2/D1/Queues/Workflows/Pipelines/AI Gateway/Browser Run) + ClickHouse Cloud + Grafana Cloud + model usage (via AI Gateway). Starts low (pilot), optimized as it scales. Track ROI via productivity metrics.

**Top risks & mitigations** (from the adversarial review, `06`):

1. **Image maintenance bit-rot** → templates + CI for builds; per-repo owner accountability + Platform tooling (US-0.3 self-service).
2. **Adoption stalls on friction in a key repo** → pilot selection care; fast iteration on per-repo tuning from session signals.
3. **Cost surprise at scale** → router + hygiene + quotas from Phase 1; daily monitoring; KV kill-switch.
4. **Security incident** → strong isolation + gates + audit from day 1; pen-test before broad rollout.
5. **Agent quality plateaus** → data flywheel + review agents + human loop + eval harness.

**External dependencies** (tracked in `08` §18): CF Sandbox SLA & snapshot/restore speed (Phase 0 spike); model provider availability/cost/pricing (multi-provider via AI Gateway); GitHub API changes/rate limits (App + user tokens).

---

## 8. Success definition (12 months)

- 40–60% of merged PRs in enabled repos have Forge session lineage or significant agent assistance.
- Measurable engineer time saved (reduced context-switching, faster iteration from traces).
- Platform self-sustaining: data-driven improvements, low support load, positive org NPS.
- Foundation for the next wave: autonomous background maintenance, deeper planning integration, potential internal "Forge Research" analyst agent.

---

## 9. Immediate next actions

1. **Stakeholder review** of this roadmap + the locked specs (`00`–`19`).
2. **Approve Phase 0** (§3). Kick off the foundation slice (§3.1) immediately — it's pure toolchain, no external dependencies.
3. **Pick pilot repos** (one backend/monolith, one frontend/TS, one infra) and line up champion owners.
4. **Provision dev-shared creds** (one platform member) — unblocks the `real` profile for everyone else.

**Build order starts at `IMPLEMENTATION_CHECKLIST.md` §1.** Each checkbox there maps to a slice here.
