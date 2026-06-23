# Forge: Security, Operations, Observability & Cost Engineering
**Status**: Canonical
**Audience**: Security, Infra/Platform, Compliance, Finance teams.

## 1. Security Model & Threat Mitigations
**Overall Posture**: Single-tenant internal platform for trusted users (behind SSO). Assume good intent but defend against prompt injection, tool misuse, data exfil, and supply-chain risks in agent loop. Strong isolation at sandbox boundary is non-negotiable.

### 1.1 Sandbox Isolation (Blast Radius Containment)
- **Provider Choice**: Cloudflare Sandbox (primary — container-level with native **Outbound Workers credential-injection boundary**); Daytona via thin provider interface (documented failover). See `08_Tech_Stack.md` §3 and ADR-0001. Chainguard Images as the base (zero-CVE by construction).
- **Network**: Egress allowlist or proxy only to approved internal services + model providers. No arbitrary outbound. DNS filtering.
- **Filesystem & Process**: Per-session fresh or snapshot-restored root FS. Path scoping in tools (OpenCode plugins enforce repo root + allowlisted dirs). No host mounts except read-only caches if needed.
- **Secrets**: Injected at spawn with short TTL (e.g., 1h), scoped to session/repo. Zeroized on exit. Never persisted in image. Use provider secret injection or DO-encrypted env.
- **User Context**: Git identity set per prompt/session (user.name/email). No shared bot identity for commits.

### 1.2 Authentication, Authorization & Attribution
- **Login to Forge**: Cloudflare Access (Zero Trust front door) → federates to **Google Workspace** (SAML/OIDC, group claims, MFA) → session token. See `08_Tech_Stack.md` §10.
- **GitHub/GitLab**: User OAuth flow at first PR creation or session start (stored encrypted in user profile or per-session). Used **only** for PR creation under that user's identity.
- **GitHub App**: Installed on org/repos for read/clone/webhooks. Bot can comment/review but **not** push/merge without human.
- **Least Privilege**: Tools/MCPs have fine-grained scopes (e.g., read-only telemetry by default; write only via explicit allow).
- **Audit**: Every prompt, tool call, file edit, commit, PR creation logged immutably with actor (user or automation ID), model, timestamp, outcome. Queryable for compliance/incident response.

### 1.3 Prompt Injection, Tool Misuse & Agent Safety
- **System Prompt Hardening**: Clear boundaries ("You are a helpful engineering coworker at [Company]. Never execute destructive commands outside repo. Always verify changes with tests/screenshots before proposing PR.").
- **Tool Schema Strictness**: JSON schema validation; allowlists per repo (e.g., no `rm -rf /`, no arbitrary curl to prod DBs). Output sanitization before model sees (redact secrets).
- **Human Gates**: Configurable per-repo or per-action sensitivity.
  - Always: PR creation requires explicit user approval (or team policy).
  - High-sensitivity repos: Extra approval or Review Agent mandatory.
  - Destructive ops (DB migrations in prod? ): Blocked or human-only.
- **Sandbox Never Trusts Agent**: All effects (commits, API calls) go through audited paths. Agent proposes; control plane + user token executes.
- **Rate Limiting & Quotas**: Per-user/session token budgets, tool call rate limits, daily spend caps with override workflow.

### 1.4 Data Privacy & Compliance
- **Sanitization Pipeline**: Before storage in analytics lake or model context (where possible): redact secrets, PII (emails, IDs, customer data via patterns + ML if needed), internal URLs/tokens.
- **Session Storage**: Raw traces in per-DO (short retention); sanitized aggregates + event stream to central lake (90-day raw or policy-defined).
- **User Consent & Transparency**: On first use, notice "Sessions are logged for improvement and audit. You control PR creation." Opt-out for sensitive sessions (still runs, less data retained).
- **Retention & Right to Delete**: Policy-driven (e.g., 30/90 days for raw sessions). Admin tools for purge on request.
- **SOC2 / ISO / GDPR Ready**: Audit logs, access controls, encryption at rest/transit (CF + provider), DPA with sandbox/model providers.

### 1.5 Supply Chain & Runtime Security
- **OpenCode & Plugins**: Vet OSS; pin versions. Layered supply-chain pipeline (see `08_Tech_Stack.md` §15): Dependabot + GHAS for Forge's own code, Chainguard Images for sandbox bases, Trivy/Syft for image + per-repo dep scanning + CycloneDX SBOMs to R2, Sigstore cosign signing + Rekor transparency log (verified at spawn), OpenSSF Scorecard for MCP registry gating. Company plugins reviewed.
- **Image Builds**: Reproducible, signed? Minimal base images. No secrets in layers.
- **Dependencies**: Dependabot or equiv on control plane code; SBOM generation.

**Residual Risks Accepted** (with monitoring):
- Model hallucination on complex logic (mitigated by verification loop + human review).
- Sophisticated prompt injection bypassing schema (defense-in-depth + monitoring for anomalous tool patterns).
- Provider outage (fallback models/providers + graceful degradation).

## 2. Observability & Tracing (Ramp-Style Data Flywheel)
**Philosophy**: "When it feels slow, know exactly where time went." Every session fully traced. Data powers product decisions, perf tuning, cost optimization, and agent improvement.

### 2.1 End-to-End Tracing (OpenTelemetry)
Spans:
- Client trigger (Slack event or Web prompt submit)
- Classifier / router decision
- Control plane orchestration (DO allocation, sandbox provision)
- Sandbox boot / snapshot restore / delta sync
- OpenCode server start + first token
- Individual tool calls (name, args sanitized, duration, tokens, result status)
- Model calls (provider, model, reasoning, TTFT, tokens in/out, cost)
- Agent iterations / checkpoints
- PR creation flow
- Human review signals (merge/close time, comments)

**Implementation**:
- Auto-instrumentation where possible (CF Workers/DO/Sandbox, AI Gateway, Browser Run, OTel SDK in plugins).
- Manual spans for critical paths + custom attributes (repo, session_id, user_id, outcome).
- Correlation IDs propagated everywhere (including into sandbox via env).
- Export to **ClickHouse Cloud via ClickStack** (OTel-native ingest) — unifies traces, metrics, logs, and the analytics lake. Grafana as the dashboard layer. Tempo/Loki/Prometheus dropped. See `08_Tech_Stack.md` §14 and ADR-0002.

**Audit Trail**: Every auditable action (prompt, tool call, edit, commit, PR creation, policy change) is written as an **Audit Event** to R2 Object Lock (Compliance mode WORM) with a Merkle hash chain anchored hourly to **Rekor** (the same Sigstore transparency log used for image signing). A queryable copy streams via Pipelines to ClickHouse. Rekor is Forge's single trust anchor — see `08_Tech_Stack.md` §5 and ADR-0005.

### 2.2 Session Data Lake & Analytics
- **Raw (sanitized)**: Prompts (redacted), full tool call history, artifacts metadata, traces, model responses summaries.
- **Aggregates**: Per-session KPIs (duration, tokens, cost, success, PR created?), per-repo heatmaps, failure taxonomy (tool errors, model loops, verification fails), common access patterns.
- **Queries Enabled** (Ramp examples):
  - "What are sessions trying to do with our design system MCP?"
  - "Which tools have highest error/retry rate?"
  - "Where is p99 latency in cold starts?"
  - "Token savings vs rework from context changes?"
- **Dashboards**: Real-time adoption, cost burn, conversion funnel, top friction areas. Drill-down to individual (sanitized) sessions.
- **Feedback Loop**: Weekly review of signals → update defaults, prompts, tool allowlists, router rules, per-repo images.

### 2.3 Alerting & Incident Response
- Platform health: control plane latency, sandbox provision success rate, model provider errors.
- Cost anomalies: daily spend > threshold or sudden spike.
- Security: anomalous tool patterns (e.g., many reads outside repo, unexpected external calls), high failure rate on sensitive repos.
- Agent behavior: sessions stuck > X min, high retry loops, low verification success.

**On-Call**: Platform team owns Forge; integration with existing PagerDuty/etc. Runbooks for common issues (warm pool exhaustion, image build fail, etc.).

## 3. Cost Engineering & Optimization (Critical at Scale)
Ramp reduced daily spend ~35% in May 2026 while growing automations 30% WoW via productized model choice + flex tiers.

### 3.1 Model Routing & Defaults (Highest Leverage)
- **Smart Default**: The **default-coding tier** model (tier 2 of the 5-tier routing in `08_Tech_Stack.md` §6) for most sessions. Best quality/speed/cost. Exact model ID chosen via eval at Phase 0; the tier structure is locked.
- **Router (cheap classifier first)**:
  - High priority / complex / user-facing / incident: Frontier + high reasoning + fast path.
  - Standard coding: Balanced.
  - Background / recurring / summaries / low-stakes automation: Flex tier (cheaper model or accepted higher latency / lower quality).
- **Per-Session Override**: User can choose; advanced users see cost estimate.
- **Learning**: Post-session outcome + cost logged → router improves (e.g., "this class of task succeeds on balanced").

### 3.2 Context Hygiene & Token Optimization (Safe)
- Eager-load only universal/common tools + system instructions.
- Defer repo-specific or heavy MCPs until task signals need.
- Prefer fast tools (rg >> grep; cached searches).
- History pruning: Summarize old turns safely when context grows (avoid RTK-style wrappers that rewrite commands and confuse model — lesson learned).
- Structured outputs where possible to reduce verbosity.
- Vision: Use efficient element extraction (React tree) vs full screenshots when applicable.

### 3.3 Infra & Execution Efficiency
- Warm pools + snapshots: Avoid full cold boots.
- Direct WS control plane ↔ sandbox (Sandboxes V2): Lower latency, fewer hops, better utilization.
- Flex for background: Accept slower completion for much better unit economics on long-tail work.
- Quotas & Governance: Per-team or per-user daily/weekly token budgets with soft/hard limits + request workflow. Prevents runaway.

### 3.4 Monitoring & Governance
- Real-time cost attribution (per session → user/team/repo/outcome).
- Weekly cost review in platform standup.
- Anomaly detection + auto-pause on suspicious patterns.
- ROI tracking: Tokens/$ per merged PR or per "verified task completed".

**Target**: Sub-linear cost growth with usage. Pilot proves model before broad rollout.

## 4. Reliability, DR & Ops
- **SLOs**: Control plane 99.9% availability; P95 prompt-to-first-action <3s (warm); sandbox provision success >99.5%.
- **Backups**: DO state (SQLite) replicated; image/snapshot registry durable; analytics lake backed up.
- **DR**: Multi-region capable (CF global); sandbox provider failover or secondary region images. Session replay from traces if state lost.
- **Chaos/Testing**: Regular game days on sandbox failure, model outage, high load. Synthetic sessions for canary.
- **Change Management**: IaC for everything; blue/green or canary for control plane updates; image builds tested before promoting to warm pool.
- **Capacity Planning**: Monitor warm pool utilization, concurrent sessions, image build queue. Auto-scale where provider allows.

## 5. Rollout & Operational Readiness
- **Pilot Phase**: 3 repos, limited users (champions + volunteers). Heavy instrumentation + daily review of sessions/failures/costs.
- **Guardrails**: Kill switches per repo or global; budget alerts; human review mandatory initially.
- **Onboarding**: Docs + "How Forge works" video (Slack thread example); champion program; per-repo owner responsible for image tuning.
- **Support Model**: #forge-support channel; in-app "Escalate" that creates Linear ticket with session link + trace summary.
- **Sunset Criteria for Old Tools**: Once Forge stable, deprecate manual local agent patterns or fragile scripts.

This pillar ensures Forge is not just powerful but **safe, observable, cost-predictable, and continuously improving** — turning every session into organizational learning, exactly as Ramp scaled to thousands of daily uses.

*Refined post-review: Explicit threat model, sanitization pipeline, human gates configurable, RTK lesson applied to context strategy, full OTel mandate, quota governance.*