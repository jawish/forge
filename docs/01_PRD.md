# Forge PRD: Product Requirements Document
**Status**: Canonical
**Date**: 2026-06-20

## 1. Executive Summary
Forge delivers a production-grade internal **agentic software factory** enabling engineers, PMs, designers, and data teams to delegate complex engineering work to AI agents that operate in full-fidelity, isolated sandboxes with complete company context, tooling, and verification capabilities. 

Inspired by Ramp Inspect (76.5% of merged PRs via agent in 6 months, 10k+ daily sessions), Forge closes the "spec-to-verified-PR" loop at company scale while maintaining human oversight, attribution, and safety.

**Target Impact (12 months)**:
- 40-60% of merged PRs initiated or significantly assisted by Forge sessions.
- 30%+ reduction in average time-to-merge for agent-started PRs.
- >70% weekly active users among engineering + enabled non-eng roles.
- Measurable productivity lift via session analytics (tool calls, iteration cycles, failure recovery).

## 2. Problem & Opportunity
**Current State**:
- Engineers spend significant time on boilerplate, context-switching, repetitive fixes, test writing, and "figuring out the environment".
- Non-engineers (PMs/Design) have ideas but lack easy path to validated implementation.
- Local agents (Cursor, etc.) limited by laptop resources, incomplete context, no parallelization, weak verification.
- Ad-hoc scripts/automation fragile and non-auditable.

**Opportunity**:
- Unlimited parallel "engineer-equivalent" capacity in secure sandboxes.
- Agents that *prove* their work (tests green, telemetry reviewed, screenshots match, feature flags exercised).
- Slack-native entry point turns every bug report, thread, or screenshot into actionable session instantly.
- Data flywheel from 100k+ sessions → better prompts, tools, model routing, per-repo tuning.

## 3. Goals & Success Metrics (SMART)
**Primary Goals**:
1. **Velocity**: Agent-assisted PRs merge 25-40% faster (measured via GitHub analytics + session linkage).
2. **Adoption**: 60%+ of eng org creates ≥1 session/week; 40%+ non-eng roles enabled via visual/Slack flows.
3. **Quality & Safety**: <5% of agent PRs require significant rework post-human review; 0 critical security incidents from agent actions.
4. **Reliability**: P95 session start <4s (warm), time-to-interactive <3s; >99.5% session success rate (non-model failures).
5. **Cost Efficiency**: LLM spend per successful merged PR under pilot-defined threshold (tracked via enriched SESSION total_cost_usd + outcome + pr_*); linear or sub-linear scaling via routing/flex tiers + budgets.

**Leading Indicators** (tracked weekly from enriched session lake — full replay, cost attribution, failure taxonomy via AUDIT_EVENT/TOOL_CALL/PROMPT):
- Session → PR conversion rate (>35% target).
- Avg tool calls / session, retry rate, and iteration cycles (declining).
- Model hallucination / tool error / rework signals.
- Per-repo cold-start time, cache hit rates, and image validation success (REPO_IMAGE_VERSION).
- Avg LLM spend per successful merged PR by repo/model (enabled by SESSION fields).

**Lagging**:
- % PRs with "Forge" in commit/PR body or co-author.
- Engineer NPS / "would recommend Forge to colleague".
- Reduction in support tickets for "how do I set up local env for X".

## 4. Scope
**In Scope (MVP — 3 months to pilot on 3 repos)**:
- Session creation from Slack (mention @Forge or react with emoji on thread/message/screenshot) + Web UI.
- Repo classifier (fast model) or explicit selection; per-repo sandbox images with tuned setup (deps, caches, pre-inits).
- Full dev sandbox (OpenCode runtime + rg, git, test runners, bash with safety, internal MCPs/tools, optional code-server + desktop stream for visual).
- Agent executes task, iterates (read/edit/test/verify), commits to branch with user git identity.
- User-attributed PR creation via GitHub OAuth (or GitLab); session link + summary in PR body/description.
- Multiplayer: real-time presence, collaborative prompting in shared session.
- Basic automations: scheduled or webhook-triggered background sessions (e.g., nightly checks).
- Observability: end-to-end tracing (OpenTelemetry), structured session logs, sanitized data lake for analytics.
- Model support: multi-provider (Claude 4.x, GPT-5.x, OpenCode Zen, etc.) with smart defaults + manual override.
- Per-session controls: model, reasoning effort, temperature hints.

**Phase 2 (Post-Pilot, +2 months)**:
- Review agents (Review Buddy style): multi-model critique/improvement of proposed diffs before human review.
- Deeper integrations: Linear/Notion issue sync, Grafana/ClickHouse alert → auto-investigation session, feature flag queries.
- Advanced cost controls: flex tiers for background, context pruning (safe), tool preference learning.
- Hosted VS Code + port tunneling for live debugging in sandbox.

**Phase 3+ (Out of Scope for MVP)**:
- Full autonomous production deploys (human + CI gates remain).
- Multi-org / SaaS multi-tenant (single-tenant internal only).
- Arbitrary code execution outside allowlisted repos/paths (strict scoping).
- Voice-first or mobile-native (web + Slack primary).

**Non-Goals**:
- Replace code review or merge authority (always human + CI + branch protection).
- Public/open-source release of Forge core (internal tool; OSS components leveraged).
- Support for non-Git workflows initially.

## 5. Personas & Entry Points
- **Senior Engineer**: "Fix this bug in checkout flow" from Linear/Slack thread → session starts with full context, proposes + verifies fix PR.
- **PM/Designer**: Drop screenshot or Figma link in Slack thread → Forge interprets visual intent, implements in sandbox, provides live preview screenshots + diff.
- **On-call / Data**: Alert fires → automation spawns investigation session; agent reproduces, finds root cause, proposes monitored fix.
- **New Engineer**: Uses Forge to explore unfamiliar service ("explain and add logging to X") with hosted tools.

## 6. Constraints & Assumptions
- **Infra**: Cloudflare (Workers + Durable Objects) for control plane (global low-latency sessions, hibernation); **Cloudflare Sandbox** for sandboxes (primary; Daytona failover via provider interface). GitHub primary (OAuth + App). See `08_Tech_Stack.md`.
- **Security Posture**: Single-tenant, trusted internal users behind SSO (Cloudflare Access → Google Workspace). Strong sandbox isolation (CF Sandbox + Outbound Workers credential boundary). No PII exfiltration; prompt/tool output sanitization.
- **Compliance**: SOC2 / GDPR ready from day 1 (audit logs, data retention policies, consent for session storage).
- **Budget**: Pilot infra ~$Y/mo; scales with usage but optimized < linear via defaults/routing.
- **Team**: Platform + 2-3 eng for core; shared ownership with eng org for per-repo image tuning.

## 7. Risks & Mitigations (Addressed)
- **Agent Hallucination / Bad Changes**: Strong verification loop + human review gate + review agents. Sandbox prevents prod impact.
- **Cost Explosion**: Model router, flex tiers, context hygiene, per-team quotas + alerts. Data-driven optimization from session traces.
- **Security / Sandbox Escape**: Provider choice with proven isolation; network egress controls; tool allowlists; secret injection with short TTL/zeroization.
- **Adoption Friction**: Slack-first zero-config start; per-repo defaults make it "just work"; dogfood + champions program.
- **Data Quality for Flywheel**: Strict sanitization rules; PII redaction; opt-out per sensitive session.
- **Multi-Repo Coordination**: Explicit decomposition or parent/child sessions; later orchestration layer.

## 8. Dependencies
- OpenCode (agent runtime) + plugins for company tools.
- GitHub App + OAuth.
- Slack App (or equiv chat).
- Sandbox provider account + custom image build pipeline (per-repo Dockerfiles or build scripts).
- Observability stack: ClickHouse Cloud + ClickStack (OTel-native) + Grafana (see `08_Tech_Stack.md` §14).
- Auth/SSO: Cloudflare Access → Google Workspace (see `08_Tech_Stack.md` §10).

## 9. Out of Box vs Custom
Leverage [background-agents OSS](https://github.com/ColeMurray/background-agents) as reference/foundation for control plane, session model, multiplayer, bots. Customize:
- Company SSO + internal user identity mapping.
- Per-repo image definitions + lifecycle scripts (`.forge/setup.sh`).
- Internal MCP server / tool registry.
- Analytics dashboard + data lake schema tuned to company repos.
- Review agent suite + tighter integration with existing CI/CD (Buildkite/GitHub Actions).

This accelerates MVP while allowing deep customization for competitive advantage (company-specific context, tools, conventions).

---
*All requirements traceable to user stories in 02_User_Stories.md. Architecture in 03_Architecture.md ensures non-functional goals (perf, security, scale) are designed in.*