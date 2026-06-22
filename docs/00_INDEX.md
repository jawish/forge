# Forge: Agentic Software Factory Platform
**Internal Background Coding & Engineering Agent Platform**  
*Inspired by Ramp's Inspect (builders.ramp.com/post/why-we-built-our-background-agent) and evolved with 2026 learnings from production scale.*

**Status**: Final Refined Design v1.1 — Ready for stakeholder review, Phase 0 spikes, and pilot kickoff. All adversarial gaps addressed.  
**Owner**: Product Engineering & Platform Team  
**Date**: June 2026  
**Audience**: Engineering Leadership, Platform Team, Security, Product for rollout planning.

## Document Suite

This suite provides a complete, production-ready specification for building and deploying **Forge** — a secure, scalable, high-adoption internal agentic platform that turns every engineer (and enabled PM/Designer/Data) into a 10x contributor by giving AI agents full sandboxed dev environments, deep company context, verification loops, and seamless workflow integration (Slack-first, Web, automations).

### Files
1. **01_PRD.md** — Product Requirements Document (concise, measurable, prioritized)
2. **02_User_Stories.md** — Detailed user stories, epics, acceptance criteria (INVEST)
3. **03_Architecture.md** — System architecture, C4-style diagrams (Mermaid), data flows, components, tech choices, sandbox lifecycle
4. **04_Interface_Design.md** — Key interfaces, user journeys, wireframe descriptions, interaction patterns (Slack, Web, In-Sandbox)
5. **05_Security_Ops_Observability.md** — Security model, compliance, cost control, observability, reliability (SOTA practices)
6. **06_Adversarial_Review.md** — Independent critique of v0 design, identified gaps/risks, mitigations addressed in final
7. **07_Implementation_Roadmap.md** — Phased rollout plan, milestones, success metrics, risks
8. **08_Tech_Stack.md** — **Authoritative technology stack specification.** Single source of truth for all vendor/tooling decisions. *Supersedes vendor-specific references in 03/05/07 wherever they conflict.*

Companion files (root):
- **`CONTEXT.md`** — Glossary of canonical domain terms (Session, Prompt, Tool Call, Artifact, Sandbox, Trust Anchor, etc.). Refer here when a term is ambiguous.
- **`docs/adr/`** — Architectural Decision Records for the surprising choices (all-CF strategy, ClickHouse unification, TanStack Start, OpenCode+Agents SDK, Rekor trust anchor, TS 7, unified artifact pipeline).

## Core Philosophy (from Inspect + SOTA)
- **Closed-loop verification**: Agent doesn't just suggest — it builds, tests, instruments, screenshots, and proves in real sandboxed env mirroring production.
- **Coworker experience**: Feels like a senior engineer who knows the repo, tools, conventions, and company context. Starts from Slack thread/screenshot/bug report with zero friction.
- **Per-repo tuning**: Images, caches, pre-warmed services, default tools/MCPs tailored (Python monolith vs TS microservices vs infra/Terraform).
- **Data-driven evolution**: Every session traced, sanitized, stored → insights on failure modes, tool efficacy, model behavior → continuous improvement of prompts, tools, defaults.
- **Cost & perf discipline**: Model routing, context hygiene, tool optimization (rg > grep), flex tiers, direct control-plane comms (WS vs HTTP hop), warm pools/snapshots. Target: <3s time-to-interactive.
- **Safety & trust**: Strong isolation, user-attributed actions (Git identity + OAuth PR creation), human review gates configurable, branch protection + CI always enforced. No blind merges.
- **Multiplayer & accessibility**: Sessions are collaborative; non-engineers contribute via visual tools/screenshots. Hosted VS Code + desktop streaming where useful.
- **Extensibility**: From coding agent → automations (alert triage) → review agents (Review Buddy style) → full software factory orchestration. Self-spawning sub-sessions.

## Key Differentiators vs Vanilla Agents (Cursor, Devin, etc.)
- Hosted, unlimited parallel sessions (no laptop bottleneck).
- Full internal context + tools (feature flags, observability, internal APIs/MCPs) without leaking.
- Verification in realistic env (run tests, query DBs/telemetry, visual frontend checks).
- Deep workflow integration (Slack origin → PR with attribution & links back to session).
- Company-specific optimizations & data flywheel.
- Production battle-tested patterns from Ramp (76.5% PRs, 10k+ daily sessions) + OSS clones.

## Open Source Leverage (Recommended)
- **Core Agent Runtime**: [OpenCode](https://opencode.ai/) (server-first, typed SDK, plugins, AI-readable codebase) — explicitly recommended by Ramp. Confirmed as the in-sandbox harness (see `08_Tech_Stack.md` §7, ADR-0004).
- **Reference Implementation**: [background-agents (Open-Inspect)](https://github.com/ColeMurray/background-agents) — MIT, multiplayer, bots, very close to spec. Use as accelerator or fork for company customizations (internal tools, auth, per-repo images).
- **Sandbox provider**: Cloudflare Sandbox (primary), with a thin provider interface and Daytona as the documented failover. See `08_Tech_Stack.md` §3 and ADR-0001 for the all-Cloudflare strategy and the accepted lock-in trade-off (supersedes the earlier "Modal / Daytona / Firecracker" shortlist).

**Build vs Buy/Adapt decision**: Strongly recommend adapting/extending the OSS reference for 3-6 month MVP vs building from scratch. Customize for company repos, SSO, internal MCPs, and compliance.

## Next Steps
1. Review this suite with stakeholders (Eng, Security, Infra, Product).
2. Pilot on 2-3 high-value repos (one monolith, one service, one infra).
3. Instrument everything from day 1 (tracing, session lake).
4. Dogfood internally; measure adoption, PR conversion, time-to-merge, NPS.
5. Iterate on data signals (common failures, slow tools) before broad rollout.

Questions or customizations (company name, Git provider, primary chat tool, sandbox infra preference)? Contact platform team.

---
*References*: Ramp Builders Blog (Jan 2026), Modal customer story (Feb 2026), @_dylanga June 2026 update thread, OpenCode, background-agents OSS, SWE-Bench inspired by Inspect PRs. All diagrams use Mermaid for portability.