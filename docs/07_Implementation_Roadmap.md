# Forge Implementation Roadmap
**Version**: 1.1 (Aligned with Refined Docs)  
**Timeline**: 6-month horizon to broad internal availability. Phased for learning + de-risking.  
**Team Model**: Platform (core infra + control plane + OpenCode plugins) + embedded eng from pilot repos (image tuning, MCPs) + Security review at each gate.

## Phase 0: Foundations & Spikes (Weeks 1-3)
**Goal**: Validate technical choices, unblock parallel work, prove core loop on 1 repo.

**Milestones & Deliverables**:
- [ ] Control plane skeleton on Cloudflare (Workers + 1-2 DOs for session state + basic WS streaming via Agents SDK).
- [ ] Sandbox Orchestrator spike: Cloudflare Sandbox account + first per-repo image build pipeline (Dockerfile + `.forge/setup.sh` example for Python/TS repo, on Chainguard base). Snapshot + restore working. Verify CF Sandbox snapshot/restore speed (open item — `08_Tech_Stack.md` §18).
- [ ] OpenCode integration: Run OpenCode server in sandbox; basic plugin for company fs/git/test tools; typed SDK calls from control plane.
- [ ] Slack Bot v0: Event ingestion, simple classifier (hardcoded or cheap model), thread posting.
- [ ] Auth spike: SSO login + GitHub OAuth for attribution (mock PR creation).
- [ ] Tracing foundation: OTel spans on critical path (prompt submit → sandbox boot → first tool).
- [ ] Security review gate: Isolation model validated; initial threat model + allowlists documented.

**Success Criteria**: End-to-end "prompt in Web/Slack → sandbox boots → OpenCode runs simple `rg` + `git status` → streams result back" in <10s on warm path. One champion can use it.

**Artifacts**: Repo with IaC (Terraform for CF), sample image defs, plugin scaffold, architecture decision records (ADRs) for key choices.

## Phase 1: MVP Pilot (Weeks 4-10)
**Goal**: Production-usable on 3 pilot repos (diverse: 1 monolith/backend, 1 frontend/TS, 1 infra). Dogfood + measure. 50-200 real sessions.

**Key Features** (maps to MVP in PRD):
- Full session lifecycle: Slack (mention/reaction + classifier) + Web creation.
- Multiplayer basic (presence + attributed prompts).
- Agent capabilities: safe edit (patches), test run, git commit with user identity, verification artifacts (test results, simple screenshots if frontend).
- PR creation with user OAuth + session link in body.
- Basic analytics: session list, simple conversion tracking, cost per session.
- Per-repo tuning: images with prewarm for each pilot repo; default tools/MCPs.
- Observability: full tracing, sanitized session lake (basic queries), dashboards.
- Safety: Human approval for every PR creation; basic audit log.

**Additional**:
- Hosted VS Code embed (code-server in sandbox) + basic terminal.
- Simple automations: 1-2 cron or webhook examples (e.g., nightly health check on one service).
- Onboarding: Internal docs site, 5-min Loom of Slack flow, champion training.

**Pilot Repos Selection Criteria**: High pain/volume, supportive owners willing to tune images & be on-call for issues, good test coverage already.

**Gates to Phase 2**:
- >30% of pilot sessions result in merged PR (or clear "no change" outcome).
- Positive champion NPS (>40) or qualitative "would use daily".
- P95 warm start <4s; no critical security or data incidents in 100+ sessions.
- Cost per successful outcome understood and under threshold.
- Security sign-off on controls + audit.

**Metrics Tracked Daily/Weekly**: Adoption (unique users, sessions), conversion funnel, latency breakdown (from traces), top failure modes, token spend vs outcome, qualitative feedback.

## Phase 2: Hardening + v1.1 Features (Weeks 11-16)
**Goal**: Make reliable for broader rollout (target 20-30% org). Add review agents + cost controls + deeper integrations.

**Features**:
- Review Buddy + Testo style: Multi-model critique/improvement of proposed changes or PR diffs. Configurable per repo.
- Advanced cost: Model router (classifier + defaults + flex for background), quotas + alerts, context hygiene rules enforced + monitored.
- Deeper integrations: Linear issue sync (create/update from session), Grafana/ClickHouse alert → auto session (with dedup), Notion context pull. (Alert source is Grafana on ClickHouse — see `08_Tech_Stack.md` §14.)
- Resilience: Checkpoints/resume, fallback models, circuit breakers, better recovery UX.
- Analytics v2: Failure taxonomy, per-repo perf/cost, "what are sessions doing with MCP X?", exportable datasets.
- Polish: Better artifacts (diff viewer, screenshot carousel), cost estimate in prompt composer, mobile Web improvements.
- Sub-session spawning + monitoring for complex tasks.

**Rollout**:
- Expand to 10-15 repos (self-service image onboarding with templates + Platform support).
- Optional Chrome extension for visual element selection (if React-heavy apps).
- Champion program expanded; lunch-and-learn + office hours.

**Gates to Broad Availability**:
- 40%+ weekly active eng users in enabled repos; non-eng usage growing via Slack/visual.
- <5% sessions require significant human rework post-PR.
- Cost scaling sub-linear; daily/weekly dashboards green.
- Zero P1 incidents; security/compliance audit passed.
- Eval harness started (internal tasks from successful pilot PRs, like Ramp SWE-Bench).

## Phase 3: Agentic Factory Expansion (Months 5-6+)
**Goal**: Move from "coding agent" to broader software factory. Self-improving elements.

**Features**:
- Automations at scale: More triggers (GitHub events, project planning tools), priority-based routing (incidents fast path), structured handoff between specialized agents (Log Reviewer → Implementor).
- Cross-repo / orchestration: Parent sessions coordinating sub-sessions across services; meta-repo or dependency graph awareness (later).
- Knowledge integration: Pull team/project context from Linear/Notion/Slack history for better "coworker who knows".
- Self-improvement: Data flywheel drives prompt/tool/router/image tuning suggestions; A/B test new defaults safely.
- "Closer to never touching GitHub": In-platform diff review + approve flows (still with human gate + CI), richer PR simulation.
- Advanced visual: Defer — code-server + Browser Run + Stagehand (locked in `08_Tech_Stack.md` §12) cover the v1 visual verification surface. Revisit only if pilot repos surface a non-browser GUI use case (Electron/desktop) that needs VNC.

**Continuous**:
- Per-repo owners maintain tuning; Platform provides self-service + monitoring.
- Weekly data review → prioritized improvements (biggest friction or cost wins first).
- Quarterly architecture review (new sandbox providers? better models?).

## Resource & Risk Plan
**Team**:
- Core Platform: 3-4 eng (infra, agent runtime, integrations, analytics) + 1 PM/Designer.
- Embedded: 1-2 per pilot repo initially.
- Security/Compliance: Review at Phase 0/1 gates + ongoing.
- Support: Platform on-call + #forge-support; scale with champions.

**Budget**:
- Infra (Cloudflare — Workers/DO/Sandbox/R2/D1/etc. + ClickHouse Cloud + model usage via AI Gateway): Starts low (pilot), scales with adoption but optimized. Track ROI via productivity metrics.
- Tools/Licenses: OpenCode (free OSS), sandbox provider, any premium models.

**Top Risks & Mitigations** (from adversarial review):
1. **Image maintenance burden / bit-rot** → Templates + CI for builds; per-repo owner accountability + Platform tooling/support.
2. **Adoption stalls on friction in key repo** → Pilot selection care; fast iteration on per-repo tuning from session signals.
3. **Cost surprise at scale** → Router + hygiene + quotas from Phase 1; daily monitoring.
4. **Security incident (rare but high impact)** → Strong isolation + gates + audit from day 1; pen-test before broad.
5. **Agent quality plateaus** → Data flywheel + review agents + human loop + eval harness.

**Dependencies External**:
- Cloudflare Sandbox SLA & feature parity (snapshot/restore speed is an open verification item — `08_Tech_Stack.md` §18; Daytona failover interface documented if needed).
- Model provider availability/cost/pricing changes (multi-provider abstraction helps).
- GitHub API changes or rate limits (handled via App + user tokens).

## Success Definition (12 months)
- 40-60% of merged PRs in enabled repos have Forge session lineage or significant agent assistance.
- Measurable engineer time saved (proxy: reduced context-switching, faster iteration cycles from traces).
- Platform self-sustaining: data-driven improvements, low support load, positive org NPS for Forge.
- Foundation for next wave: autonomous background maintenance, deeper planning integration, potential internal "Forge Research" data analyst agent, etc.

This roadmap is aggressive but realistic given OSS accelerator and Ramp's timeline (prototype to high adoption in months). Focus on dogfooding + measurement in pilot will de-risk and build internal momentum.

**Immediate Next Action**: Stakeholder review of this full doc suite (00-07). Approve Phase 0 spikes. Kick off repo selection for pilot.

---
*Forge turns the software factory into an agent-augmented, data-driven, verification-first environment — starting simple, scaling safely, improving forever.*