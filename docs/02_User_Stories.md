# Forge User Stories & Requirements
**Version**: 1.1 (Refined) | **Format**: INVEST + Gherkin-style acceptance criteria where complex.

## Epic 0: Foundation & Platform Bootstrapping
**US-0.1** As a Platform Engineer, I can provision a new Forge deployment (control plane + sandbox provider) so that the system is ready for repo onboarding.  
**AC**: Pulumi IaC for CF + ClickHouse Cloud + Grafana Cloud; one-click image build for sample repo; health checks pass; docs for per-repo customization.

**US-0.2** As Platform, I define per-repo sandbox images (Dockerfile + setup scripts) with pre-installed deps, caches (mypy, node_modules, TF init, test DB snapshots), and default tools/MCPs so first sessions are fast and relevant.  
**AC**: Build pipeline runs every 30min or on repo change; snapshot restore <2s; warm pool for top 5 repos.

**US-0.3 (High Priority for Scale)** As a Repo Owner or delegated maintainer, I can self-service onboard or update my repo's Forge configuration (image Dockerfile, setup.sh, prewarm commands, default MCP allowlist, sensitive paths, tuning params) via Web UI or CLI so that Forge "just works" for my codebase without Platform tickets or delays.  
**AC**:
- Wizard validates build succeeds in sandbox, measures cold-start/warm time, suggests improvements.
- Versioning of configs + history/diff view.
- Approval workflow for sensitive changes (or auto for safe ones); staleness alerts.
- Directly improves per-repo UX and reduces support load.

## Epic 1: Session Creation & Lifecycle (Core Loop)
**US-1.1 (P0)** As any enabled user (eng/PM/design), I can start a Forge session from a Slack thread or message (via @mention or custom emoji reaction) with a bug report, feature idea, screenshot, or vague "this feels off" so that an agent begins work in the right repo with rich context without me specifying repo or writing a formal spec.  
**AC**:
- Fast classifier model (cheap/small model) + repo catalog (descriptions, examples, ownership, embeddings for similarity) routes to correct repo with confidence score. If confidence < threshold or "unknown", posts clarifying question in thread with top suggestions + "reply to route or specify repo".
- Session inherits thread context, attachments (images parsed via vision or OCR + description), channel metadata, recent relevant commits summary.
- Confirmation posted in thread with session link, estimated start, and classifier confidence.
- Repo catalog is self-maintainable (simple UI or PR to update descriptions/examples; staleness detection alerts owners).
- Gherkin: Given a Slack thread with screenshot of UI bug in checkout, When user reacts with :forge: emoji, Then classifier selects frontend repo (confidence 92%), session starts, agent receives vision description + thread summary + recent checkout changes, posts "Investigating..." update. If low confidence, posts "Unsure of repo — does this relate to frontend, backend, or infra? Reply to confirm."

**US-1.2 (P0)** As a user, I can create/start a session from the Web UI (dashboard or quick-start) selecting repo + prompt (text or voice-to-text) or pasting Linear/Notion link so that I have more control for complex tasks.  
**AC**: Repo picker with search/favorites; prompt templates per repo; session appears in "My Sessions" instantly.

**US-1.3** As user or agent, a session can spawn child/sub-sessions (parallel research or multi-repo decomposition) so complex work can be broken down without blocking.  
**AC**: Tool `spawn_session(repo, prompt, parent_id)`; parent monitors status; results aggregated or linked.

**US-1.4** As user, I can join an existing multiplayer session (or be invited) and contribute prompts/steer while seeing real-time output and presence of others so collaboration feels natural (e.g., PM + eng pair on feature).  
**AC**:
- WebSocket presence (avatars + "User X is typing/steering"); prompts attributed to specific user.
- Shared view of current agent state/diff (optimistic updates with conflict indicators).
- Conflict resolution: Git branch is source of truth. Concurrent prompts queue or merge via rebase on agent side; manual edits in hosted VS Code take precedence with notification; last prompt wins on overlapping file edits with clear audit in replay. No silent data loss.
- Shared workspace mode optional (vs independent prompt branches for safety).

**US-1.5** As user, I receive real-time streaming updates in Slack thread or Web UI (thinking, tool calls summarized, progress, final summary + PR link) so I stay informed without polling.  
**AC**: Streaming via CF Agents SDK / WS; rate-limited summaries for Slack to avoid noise; full trace in Web.

## Epic 2: Sandbox Execution & Agent Capabilities (Closed Loop)
**US-2.1 (P0)** As the agent (powered by OpenCode + company plugins), in a fresh or restored sandbox I have full access to: filesystem search/edit (safe rg/read/write with path scoping), bash exec (allowlisted, timeout, audit), git (user identity configured), test runners, internal MCPs (feature flags, observability query, DB if safe — read-only views or scoped schemas with short-lived session tokens), browser tooling (headless or streamed) so I can verify changes end-to-end like a human engineer.  
**AC**:
- Per-repo allowlists & default tools/MCPs loaded eagerly; others deferred. MCPs use session-scoped short-lived auth tokens or signed requests (never long-lived creds in sandbox).
- DB access (if enabled): Read-only views or time-boxed query sandboxes; no direct prod writes; audited.
- Edits via structured patches or safe file ops (OpenCode plugin-enforced); never direct prod impact.
- Pre-warmed: caches hot, services (local stack) running where applicable (e.g., docker-compose up in image for microservices).
- Example: Agent runs `pnpm test --filter checkout`, sees failure, reads logs, fixes, re-runs, confirms green + screenshots match spec.

**US-2.2** As agent or user, I can use hosted VS Code (code-server) or web terminal inside the sandbox session for manual inspection/debug when needed (or for teaching).  
**AC**: One-click open from Web UI; ports tunneled securely; changes sync back to agent context if desired.

**US-2.3** As agent, I produce verifiable artifacts (test results, diffs, before/after screenshots via agent-browser or VNC, telemetry snapshots, feature flag impact) attached to session and summarized in PR so human reviewer has everything needed for fast approval.  
**AC**: Artifacts stored & linked; PR description auto-populated with summary + links + "Verified in Forge sandbox session XXX".

## Epic 3: Git & PR Integration (Attribution & Safety)
**US-3.1 (P0)** As user who started the session (or authorized collaborator), when agent signals "ready for review", I can review a preview (diff + artifacts + summary) and explicitly approve "Create PR" (or team policy allows auto-create after ready + Review Agent pass) so changes are pushed to a branch and PR opened using *my* GitHub identity/token (not shared bot) with proper attribution and session traceability.  
**AC**:
- Git config user.name/email set to prompting user's identity per prompt or session (control plane or secure injection; never long-lived token in sandbox).
- Branch naming: `forge/<user>/<session-shortid>-<slug>`.
- Preview available in Web (or Slack deep-link to Web modal) showing unified diff, key artifacts, test results, estimated impact.
- PR created via GitHub API with user's OAuth token (control plane mediated); body includes session URL, key artifacts, "Co-authored-by: Forge Agent" + "Verified in Forge sandbox".
- Branch protection + required CI + human reviewers enforced (agent cannot bypass). Configurable per-repo policy for auto-create vs explicit approval.
- Clear ownership: User (or policy) triggers final create; agent only proposes.

**US-3.2** As reviewer or author, I see Forge session link in PR and can jump back to full replay/trace so I understand agent reasoning and artifacts.  
**AC**: Bidirectional links; optional "Re-run with my prompt" or "Continue in Forge" from PR comment.

**US-3.3** As Platform/Security, all agent actions are fully audited (who prompted, what tools called, what files changed, model used) with retention policy so compliance/ incident investigation is possible.  
**AC**: Immutable event log + session replay capability (sanitized).

## Epic 4: Automations & Background Workflows (Agentic Factory)
**US-4.1** As on-call or Platform, I can define an automation (cron, webhook from Grafana/ClickHouse alert, Linear status change, or GitHub event) that spawns a background Forge session with templated prompt + context so routine investigations or maintenance happen autonomously.
**AC**:
- Priority routing: incidents use fast/high-quality path; background use flex/cheaper tier.
- Deduping & idempotency keys to avoid duplicate work on same alert.
- Session result (investigation report + proposed PR or "no action needed") posted back to incident channel or Linear.
- Example (from Ramp inspiration): Log reviewer sweeps staging/prod via Grafana MCP, produces structured handoff → Implementor agent picks up and opens PR.

**US-4.2** As eng manager, I configure repo-specific or org-wide review agents (Review Buddy + Testo style) that automatically critique proposed PR diffs (or Forge-generated ones) using multiple frontier models for security, perf, style, test coverage, business logic so human review is higher signal.  
**AC**: Runs on PR open or Forge "ready for review" signal; posts structured comments or improves the branch; configurable strictness per repo.

## Epic 5: Experience, Performance & Polish (Obsess Over UX)
**US-5.1** As user, sandbox sessions feel instant and "know the codebase" (per-repo defaults, recent changes pre-synced or warm, relevant MCPs loaded) so I don't waste time on setup or guiding the agent.  
**AC**: P95 cold start <5s (image + snapshot); warm <2s; context includes repo map or recent commits summary if useful; "feels like coworker who already knows".

**US-5.2** As user, when things are slow or fail I get transparent diagnostics (where time went: model TTFT, tool latency, sandbox boot) and quick recovery options (retry with different model, continue from checkpoint).  
**AC**: Full distributed tracing visible in session UI; one-click "Optimize & Retry" or "Escalate to human".

**US-5.3** As Platform, I have rich analytics (adoption heatmaps, common failure paths, tool rework rates, model cost per outcome, per-repo perf) from the session data lake so I can prioritize improvements (e.g., "improve MCP for design system").  
**AC**: Dashboard with time-series, drill-down to raw (sanitized) sessions; export for custom analysis. Ramp-style questions answerable: "What are sessions trying to do with our MCP X?"

## Epic 6: Cost, Scale & Reliability (Non-Functional Embedded)
**US-6.1** As Finance/Platform, LLM and infra costs scale sub-linearly with adoption thanks to smart defaults (GPT-5.5-medium or company equivalent), flex tiers for background, context hygiene, and tool optimizations (prefer rg, cached searches, etc.).  
**AC**: Daily/weekly cost dashboards; alerts on anomalies; <35% spend reduction demonstrated like Ramp via routing (May 2026 example).

**US-6.2** As user, sessions are resilient: partial failures (tool timeout, model rate limit) trigger smart retry/backoff or graceful degradation without losing context; long-running tasks support checkpoints/resume.  
**AC**: Circuit breakers, fallback models, session state persisted in DO SQLite; resume from last successful step.

## Cross-Cutting / Non-Functional Requirements (NFRs)
- **Performance**: Session start (prompt to first token/action) P95 <3s after warm image; tool calls p95 optimized (rg 41%+ faster example).
- **Reliability**: 99.9% uptime for control plane; sandbox provider SLA; graceful degradation.
- **Security**: See 05_Security...md — zero-trust elements, isolation, least-privilege tools, full audit.
- **Privacy**: Session data sanitized (secrets redacted, PII minimized); user consent for storage/analytics; retention policies (e.g., 90 days raw, aggregated forever).
- **Accessibility**: WCAG AA for Web UI; Slack-first for broad access; keyboard/screen-reader friendly.
- **Extensibility**: Plugin system (OpenCode plugins + custom MCP registry); API for internal tools to register capabilities.
- **Observability**: OTel everywhere (traces span client → control → sandbox → model calls); metrics (session duration, token usage, success); logs structured.

## Prioritization & MVP Definition
**MVP (Pilot on 3 repos, 1-2 months build + 1 month pilot)**: US-0.x + 1.1-1.5 (core Slack + Web start, basic multiplayer) + 2.1-2.3 (sandbox execution + verification) + 3.1-3.2 (user-attributed PRs) + basic tracing/analytics.  
Leverage OSS reference heavily for 70% of plumbing.

**Success Gate for Broader Rollout**: >30% session→PR conversion in pilot; positive dogfood NPS; <2 critical bugs in 1000 sessions; cost per PR under threshold.

All stories map to Architecture components (Session Manager, Sandbox Orchestrator, Agent Runtime via OpenCode, Integration Layer, Analytics Service).

*Refined post-review: Added explicit safety gates, audit, cost NFRs, sub-session spawning, review agents as v1.1, stronger per-repo tuning emphasis.*