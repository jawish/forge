# Forge: Agentic Software Factory Platform
**Internal Background Coding & Engineering Agent Platform**  
*Inspired by Ramp's Inspect (builders.ramp.com/post/why-we-built-our-background-agent) and evolved with 2026 learnings from production scale.*

**Status**: Canonical design — ready for stakeholder review, Phase 0 spikes, and pilot kickoff.
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
6. **06_Adversarial_Review.md** — Independent critique of the design: the gaps/risks identified and the mitigations now embodied in the canonical specs.
7. **07_Implementation_Roadmap.md** — **Engineering execution track.** Build order + vertical-slice decomposition aligned to the locked specs (`08`–`19`), with detailed Phase 0 and the Phase 1/2/3 plan.
8. **08_Tech_Stack.md** — **Authoritative technology stack specification.** Single source of truth for all vendor/tooling decisions. *Supersedes vendor-specific references in 03/05/07 wherever they conflict.*
9. **09_Project_Structure.md** — **Authoritative engineering structure.** Monorepo layout (apps/packages/infra), Worker topology (2 Workers split by deployment cadence), the unified `domain` package, build orchestration (pnpm + mise), and the two-profile local dev environment (`fast` / `real`).
10. **10_API_Contracts.md** — The contract at each of Forge's six system seams (Web↔control-plane via tRPC; control-plane↔DO in-process; browser↔DO via Agents SDK Client SDK; external webhooks via zod; agent↔control-plane via MCP tools; ops/debugging REST-ish).
11. **11_State_Model.md** — **Authoritative session lifecycle.** Two-field state model: `status` (9 lifecycle values) + `activity` (5 sub-values when active). Full transition table with guards and side effects.
12. **12_Data_Schemas.md** — Concrete DDL for all four stores: DO SQLite (hot, source-of-truth), D1 (control-plane OLTP index), R2 (blobs + WORM audit), ClickHouse (analytics lake + observability). Includes DO API surface and migration strategy.
13. **13_Configuration.md** — Three config domains (repo / org / env). Repo config = `.forge/config.toml` (TOML, versioned in git); Web UI is a PR-generating editor. Full schema with build-time vs runtime field split.
14. **14_Observability_Conventions.md** — OTel attribute namespace (`forge.*` + semantic conventions), service names, span naming, and the session-scoped head sampling + status-aware promotion strategy (3.6× span reduction, 100% failure capture).
15. **15_Error_Model.md** — Contract-first error model: 7 categories (decision-types, not failure-modes) + organic domain codes. Per-seam integration (tRPC, MCP, user-facing, auto-retry).
16. **16_Testing.md** — Integration-heavy "testing trophy" shape (seam tests = 80%) with mocked-externals-at-the-boundary convention. Risk-allocated CI gate (strict on deterministic seams, advisory E2E, staging for real-model).
17. **17_Environments.md** — 3 envs (dev/staging/prod), no per-engineer cloud. Pulumi stacks per env. Sanitized prod → staging nightly. Pulumi-managed secrets with CI gate + 2-person prod approval.
18. **18_Security_Contracts.md** — Two security primitives: (A) sanitization pipeline (projection-first — schema excludes sensitive fields by construction; layered redaction only for the few included content fields) and (B) Outbound Workers boundary (per-sandbox + per-MCP manifests, deny-by-default, per-call credential injection).
19. **19_Integration_Contracts.md** — Two integration surfaces: (A) Slack classifier (two-stage: intent filter + repo router; tiered confidence: auto-spawn/confirm/disambiguate/explain) and (B) extension model (one seam — MCP only; OpenCode integration via configure-not-fork; `plugin-sdk` = MCP author SDK).

Companion files (root):
- **`IMPLEMENTATION_CHECKLIST.md`** — The tickable step-by-step build list. Start here when implementing; each checkbox maps to a slice in `07`.
- **`README.md`** — Concise dev-environment setup, tasks, and repo orientation.
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