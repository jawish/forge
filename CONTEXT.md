# Forge — Context & Glossary

Canonical language for the Forge platform. Terms are domain-meaningful (not implementation details). When a doc uses one of these words, it means what's defined here. If a doc means something else, it should use a different word.

> Maintained alongside `docs/08_Tech_Stack.md` (authoritative tech-stack spec) and `docs/adr/` (architectural decisions). Update inline as terms are resolved.

## Core domain entities

- **Session** — A single unit of agentic work against one repo on one branch: from prompt received to PR-ready (or abandoned). The central aggregate root of the domain model. Has a lifecycle (`in_progress → ready_for_pr → pr_created → merged | failed | no_change | cancelled`). *Not to be confused with a browser session or a Slack conversation.*
- **Prompt** — A single user (or system) instruction submitted to a Session. The atomic unit of agent input. Has attribution (which user submitted it) and a model-params snapshot (which model, reasoning level, temperature was used for that turn).
- **Tool Call** — One invocation of a tool by the agent during a Session (e.g., `read_file`, `run_tests`, `web_fetch`). Recorded with args, result, duration, token cost, exit code, retry count. The finest-grained unit of agent behavior.
- **Artifact** — A durable output of a Session: diff, test result, screenshot, telemetry excerpt, report, or review critique. Stored as a blob (R2) with a typed metadata record. *Not to be confused with an OCI Artifact (packaging unit — see below).*
- **Repo** — A registered target repository (GitHub org/repo) that Forge can operate on. Has per-repo config (Dockerfile, setup scripts, MCP allowlist, tuning).
- **Repo Image Version** — A specific built sandbox image for a Repo at a point in time (commit + dependencies + caches). Immutable, signed. Sessions pin to a specific version.

## People & agents

- **User** — A human engineer at the company, authenticated via Google Workspace through Cloudflare Access.
- **Actor** — Anything that performs an auditable action: a User, the automation system, or an Agent. Every Audit Event has exactly one Actor.
- **Agent** — The OpenCode harness running inside a Sandbox, executing a Session. *Not to be confused with the Cloudflare Agents SDK (the control-plane transport) or a Review Agent (a specialized sub-agent).*
- **Review Agent** — A specialized agent that reviews another Session's output (diff, tests, screenshots) before PR creation. Optionally mandatory for high-sensitivity repos.

## Infrastructure

- **Control Plane** — The Cloudflare Workers + Durable Objects layer that orchestrates Sessions: receives prompts, allocates sandboxes, streams state, enforces gates. The "brain" of Forge. *Not to be confused with the Sandbox (where work happens).*
- **Sandbox** — An isolated, ephemeral compute environment (Cloudflare Sandbox) where one Session's agent runs. Per-session, fresh-or-snapshot-restored, credential-injected at spawn, zeroized on exit. The "hands" of Forge.
- **Warm Sandbox** — A pre-booted Sandbox (from a recent snapshot) kept ready for high-volume repos to minimize time-to-interactive.
- **Snapshot** — A captured filesystem + memory state of a Sandbox, used to fast-start subsequent sessions for the same Repo Image Version.

## Security & trust

- **Audit Event** — An immutable record of one auditable action (prompt, tool call, edit, commit, PR creation, policy change). Written to R2 Object Lock (WORM) and queryable via ClickHouse. Has a Merkle-hash-chain link to the previous event.
- **Trust Anchor** — The single public source of truth for cryptographic verification: Sigstore's Rekor transparency log. Anchors hourly Merkle roots of the Audit Event chain AND signatures of OCI Artifacts (sandbox images, MCP servers). "Verify against the public Merkle root" is Forge's SOC2 story.
- **Sanitization** — The pipeline that scrubs secrets, PII, and internal tokens out of session data before it lands in the analytics lake (ClickHouse) or model context. Runs before storage, not after.
- **Kill-Switch** — A KV-backed feature flag checked synchronously before every model call. Allows immediate platform-wide pause (cost overrun, security incident, provider outage) without redeploy.
- **Outbound Workers Boundary** — The Cloudflare Sandbox egress layer that injects short-TTL credentials into sandbox network calls at the edge. The agent never holds secrets; the boundary does.

## MCP & artifacts

- **MCP (platform-provided)** — An MCP server Forge ships as part of the platform (e.g., Browser Run, Stagehand). Always available, governed by platform policy, not the registry. *Not to be confused with registry-managed MCP.*
- **MCP (registry-managed)** — A third-party MCP server registered in Forge's catalog (federated from the official MCP Registry or added privately). Governed by the full artifact pipeline: OCI + cosign + Scorecard + per-repo enable list + permission manifest.
- **OCI Artifact** — A packaging unit (not a Session Artifact): a signed, versioned, digest-pinned container image stored in GHCR. Used for both sandbox images and registry-managed MCP servers. May be bundled via KitOps ModelKits.
- **Permission Manifest** — The declared filesystem/network/secrets scope of an MCP server or sandbox image, enforced at runtime by the Outbound Workers Boundary.

## Operational

- **Model Tier** — One of five routing classes for model selection (frontier / default-coding / flex / coding-specialist / classifier). Per-session override is configurable; the tier *structure* is locked, exact model IDs are chosen via eval at Phase 0.
- **Cost Counter** — An incremental token/cost accumulator held in the Session's Durable Object SQLite, checked synchronously before each model call against the budget.

## Non-canonical / discouraged terms

- **"Account"** — ambiguous. Use **User** (human) or **Repo** (the thing being worked on).
- **"Job"** — ambiguous. Use **Session** (agent work) or **Workflow** (a Cloudflare Workflows execution).
- **"Bot"** — ambiguous. Use **GitHub App** (the Forge bot identity on GitHub) or **Slack Bot** (the Slack entry surface).
