# Forge — Technology Stack Specification

**Version**: 1.0 (locked)
**Status**: Authoritative. Supersedes vendor-specific references in `03_Architecture.md`, `05_Security_Ops_Observability.md`, and `07_Implementation_Roadmap.md` wherever they conflict.
**Companion docs**: `CONTEXT.md` (glossary), `docs/adr/` (architectural decision records for the surprising choices).

> This document is the single source of truth for the technology stack. It was produced by a grilling interview that locked 19 decisions, each with rationale and rejected alternatives. The ADRs capture the *surprising* decisions in depth; this document captures *all* decisions concisely.

---

## Stack at a glance

| Layer | Choice | ADR |
|---|---|---|
| Cloud | Cloudflare (sole cloud) | 0001 |
| Compute (control plane) | Workers + Durable Objects | — |
| Compute (agent work) | Cloudflare Sandbox (primary), Daytona (documented failover) | 0001 |
| Model abstraction | Cloudflare AI Gateway | 0001 |
| Visual verification | Browser Run + Stagehand | — |
| Frontend | TanStack Start (on CF Workers) | 0003 |
| Agent harness | OpenCode (in-sandbox, MCP-native) | 0004 |
| Control-plane transport | Cloudflare Agents SDK + Client SDK | 0004 |
| Hot state | Durable Object SQLite | — |
| Control-plane OLTP | D1 | — |
| Object/blob storage | R2 (+ Object Lock for audit) | 0005 |
| Config cache / flags | KV | — |
| Vector store | Vectorize | — |
| Analytics lake + observability | ClickHouse Cloud + ClickStack | 0002 |
| Dashboards | Grafana (on ClickHouse) | 0002 |
| Trust anchor | Sigstore Rekor | 0005 |
| Auth (web) | Cloudflare Access → Google Workspace | — |
| Auth (git) | GitHub App + per-user GitHub OAuth | — |
| Package manager | pnpm | — |
| Language | TypeScript 7 (Go-native), TS 6 fallback | 0006 |
| Lint / format | Oxlint / Oxfmt (Prettier fallback) | 0006 |
| Test | Vitest + Playwright | — |
| IaC | Pulumi (TS-native) | — |
| CI/CD | GitHub Actions + CF Workers Builds | — |
| Secrets | Cloudflare Secrets Store | — |
| MCP/artifact governance | Federate MCP Registry; OCI in GHCR via KitOps; D1 policy | 0007 |
| Supply chain | Dependabot + GHAS + Chainguard + Trivy/Syft + Sigstore + Scorecard | — |
| Slack entry surface | Slack Bolt SDK on CF Worker | — |
| Embeddings / classifier | Workers AI → Vectorize | — |

---

## 1. Deployment context

Forge is a **real internal platform** at an existing company that runs on **Cloudflare** (cloud) and **Google Workspace** (identity). Vendors were chosen best-of-breed under the constraint of fitting a CF-first, Google-identity shop — not ported from an inherited stack. Production-grade: vendors must be real, security must pass audit, costs must be justifiable.

---

## 2. Cloud & compute surface

Cloudflare is the sole cloud. The product surface, locked during the Agents Week 2026 (April) research sweep:

| Product | Role | Status (Jun 2026) |
|---|---|---|
| **Workers** | Control-plane compute: API, Slack ingestion, auth proxy, session gateway, classifiers | GA |
| **Durable Objects** | Per-session stateful state (SQLite-backed), WS hibernation, orchestration | GA |
| **Sandbox** | Agent compute: persistent containers, PTY-over-WS, snapshots to R2, egress-proxy credential injection | GA (Agents Week 2026) |
| **AI Gateway** | Unified model call surface; routes to 7 providers; caching, rate limits, cost tracking, fallback | GA |
| **Browser Run** | Agent visual verification: Live View, HITL breakpoints, CDP, session recordings, WebMCP | GA (rebrand of Browser Rendering) |
| **R2** | Blob storage (artifacts, screenshots, snapshots); WORM audit via Object Lock | GA |
| **D1** | Control-plane OLTP (session index, repo registry, settings, audit index, MCP catalog) | GA |
| **KV** | Low-latency config cache, rate-limit counters, feature flags, kill-switch | GA |
| **Vectorize** | Vector index for the repo/task classifier | GA |
| **Hyperdrive** | Connection pooling to external Postgres (reserved for future analytics escape hatch) | GA |
| **Queues** | Async background work: image builds, alert-triggered sessions, post-session analytics | GA |
| **Workflows** | Durable multi-step orchestration: session lifecycle, retry/checkpoint, compensation | GA |
| **Pipelines** | Streaming ingestion → R2/Parquet/Iceberg; used for audit + analytics events | GA (pricing May 2026) |
| **Flagship** | Native feature flags (KV+DO-backed, OpenFeature-compatible) | GA |
| **Secrets Store** | Unified secrets source of truth (control-plane bindings, OAuth master key, repo-defined) | GA |
| **Access** | Zero Trust front door to Forge Web; federates to Google Workspace | GA |
| **Mesh** | Private networking for agent → internal service calls | GA |
| **Agent Memory** | Managed persistent cross-session agent memory | Beta (pricing/limits unpublished) |
| **Artifacts** | Git-compatible versioned storage for agent branches | Beta (pricing/limits unpublished) |
| **Unweight** | Lossless MLP-weight compression (~22% footprint reduction) | **Not applicable to Forge** — CF Research/internal infra; only benefits Workers AI-hosted inference, NOT arbitrary providers via AI Gateway (see §18) |
| **Container Registry** | Hosting OCI artifacts (sandbox images, MCP servers) — or GHCR (chosen, see §13) | GA |

---

## 3. Sandbox & isolation

**Primary**: Cloudflare Sandbox (persistent container, PTY-over-WS, snapshots to R2, **Outbound Workers credential injection** — the agent never holds secrets).

**Failover**: thin provider interface with **Daytona** as the documented (not built) secondary. If CF Sandbox materially underperforms on snapshot-restore speed or pricing, the interface is the swap point.

**Base images**: Chainguard Images (zero-CVE by construction — eliminates the largest CVE surface rather than scanning to find it).

**CF Sandbox operational facts (verified Jun 2026)** — material to the warm-pool design:

- **Cold start: ~1–3 seconds** (image-size-dependent). The "~5ms" figure sometimes cited is for Workers (V8 isolates), *not* Sandbox/Containers. Plan UX around the 1–3s figure, not sub-millisecond.
- **Snapshot/restore: supported via the Backups API** (point-in-time directory snapshots, restored as copy-on-write overlays). This is the Modal-analogous primitive. *No published speed benchmark* — verify during Phase 0 spike (open item, §18).
- **`sleepAfter` default = 10 min** of inactivity → sandbox auto-sleeps. **Sleep clears all ephemeral files and processes**; only R2-mounted paths survive. Use `keepAlive: true` for long-lived daemons. No documented upper bound on `sleepAfter`.
- **Resource limits**: max 4 vCPU / 12 GiB RAM / 20 GB disk per sandbox; min 3 GiB memory per vCPU. Lite instances support up to 15,000 concurrent.
- **Active-CPU pricing**: ~$0.072/vCPU-hour (billed for CPU-active time, not wall-clock) + $0.025/GB egress (1 TB/mo included). Requires Workers Paid ($5/mo floor); no free tier.
- **Isolation**: VM-level boundary (Cloudflare's claim) with a Linux container per sandbox. Cloudflare does **not** publicly name the specific microVM substrate — **do not assume Firecracker**. Treat the contract as: VM boundary + Linux container, safe for untrusted code per Cloudflare's explicit claim. Resolve the threat-model specificity before production if a regulated auditor requires a named substrate.
- **Single-PoP execution**: unlike Workers (which run in every PoP), a sandbox instance lives in **one data center**, placed near the first request and sticky thereafter. Plan routing accordingly — a sandbox placed far from its backing services can suffer 16× latency (documented community case). Per-sandbox region pinning is not exposed via API.
- **Known issues**: `sandbox.exec()` can hang indefinitely (tracked); `sandbox IDs` must be 1–63 chars.

> See ADR-0001 for the all-CF strategy rationale and the accepted lock-in trade-off.

---

## 4. Data layer

Four stores, each serving a distinct access pattern. **The Durable Object SQLite is the source of truth for live session state; everything else is one-way derived.**

```
DO SQLite (source of truth, hot per-session)
    │
    ├──→ D1          (derived index — eventually consistent; session list, repo registry, settings)
    ├──→ R2          (blobs + WORM audit — append-only; Object Lock Compliance mode)
    └──→ ClickHouse  (derived analytics — sanitized event stream; queryable lake)
```

| Store | Role | Consistency |
|---|---|---|
| **DO SQLite** | Hot per-session state (in-flight prompts, tool calls, presence, cost counters) | Strong (single DO per session) |
| **D1** | Control-plane OLTP: session index, repo registry, user/org settings, audit index, MCP catalog, quota store | Eventually consistent (derived from DO) |
| **R2** | Blobs (artifacts, screenshots, snapshots, SBOMs); WORM audit trail via Object Lock | Immutable (append-only) |
| **KV** | Low-latency config cache, rate-limit counters, Flagship feature flags, kill-switch | Eventually consistent |
| **Vectorize** | Vector index for the repo/task classifier (semantic prompt → repo routing) | — |
| **ClickHouse Cloud + ClickStack** | Unified traces + metrics + logs + sanitized analytics lake; OTel-native ingest | Derived (via Pipelines) |

**Data-flow direction (one-way):** DO → (D1 index, R2 audit, ClickHouse analytics). No store writes back to DO.

> Note: ClickHouse Cloud is regionally pinned; CF is global. Analytics writes are async via Pipelines (acceptable latency for analytics; documented trade-off).

---

## 5. Audit & trust anchor

The canonical immutable audit trail, built from components locked for other reasons:

- **R2 Object Lock (Compliance mode)** — WORM storage. Even root cannot delete within retention.
- **Merkle-tree hash chain** — each audit event includes the hash of the previous event. Tamper-evident.
- **Hourly anchor to Rekor** — the Merkle root is published to Sigstore's public transparency log. Modifications become publicly detectable.
- **Pipelines** streams audit events to both R2 (immutable) and ClickHouse (queryable copy) in one pipeline.

Compliance officers query ClickHouse ("every PR creation by user X in 90 days"). To verify integrity, re-derive the Merkle root from R2 and check it against Rekor.

**Rekor is Forge's single trust anchor** — it also anchors OCI Artifact signatures (sandbox images, MCP servers). One verification surface for audit integrity, image authenticity, and MCP registration.

> See ADR-0005 for the unification rationale.

---

## 6. Models & routing

**Abstraction layer**: Cloudflare AI Gateway (unified call surface; caching, rate limits, cost tracking, per-provider fallback).

**Providers** (all routed via AI Gateway):
- OpenAI (direct — native provider)
- Anthropic (direct — native provider)
- Google (Vertex / Gemini — native provider)
- xAI Grok (direct — native provider)
- Z.ai (GLM) — via AI Gateway's **openai-compatible escape hatch** (not a native provider ID; verify the `/v1` prepend quirk against the target gateway version)
- Moonshot Kimi — via openai-compatible escape hatch (same caveat)
- OpenRouter (meta-provider — native provider; **0% token markup**, 5.5% credit-purchase fee, BYOK supported; use as fallback for any provider not directly contracted, with `:floor`/`:nitro` routing suffixes)

**5-tier routing structure**:

| Tier | Use case | Example models (illustrative — exact IDs chosen via eval at Phase 0) |
|---|---|---|
| 1 — Frontier reasoning | Complex multi-step planning, architecture | Claude Opus 4.8 (`claude-opus-4-8`, $5/$25 per 1M tok, 1M ctx) · GPT-5.5 (`gpt-5.5`, $1.25/$10, 400k ctx) · Gemini 3.1 Pro Preview · Claude Fable 5 (`claude-fable-5`, $10/$50) if budget allows |
| 2 — Default coding | Workhorse for most sessions | Claude Sonnet 4.6 (`claude-sonnet-4-6`, $3/$15, 1M ctx) · Gemini 3.5 Flash ($1.50/$9) · GPT-5.4 ($1.25/$10) |
| 3 — Flex / cheap background | Summarization, title gen, low-stakes | Gemini 3.1 Flash-Lite (`gemini-3.1-flash-lite`, $0.25/$1.50) · Claude Haiku 4.5 ($1/$5) · GPT-5 mini ($0.25/$2) · GLM-4.7-FlashX ($0.07/$0.40) |
| 4 — Coding specialist | When the default isn't the best coder | GLM-4.6 (`glm-4.6`, $0.60/$2.20 — Z.ai's coding flagship at ~12% of Opus cost) · Grok Build 0.1 (`grok-build-0.1`, $1/$2) · Kimi K2.6 (~$0.60/$2.20) · GPT-5.3-Codex |
| 5 — Classifier / router | Token-light routing + embeddings | Workers AI (local, no egress) for classifier + embeddings → Vectorize. Gemini 3.1 Flash-Lite / GPT-5 nano (`gpt-5-nano`, $0.05/$0.40) for cloud-classifier when richer tool-calling needed |

> **Note (Jun 2026)**: Gemini 2.0 Flash and 2.0 Flash-Lite were **shut down June 1, 2026** — do not use them. Gemini 3.x Flash variants are the current non-deprecated cheap tier.

**Deferral**: the tier *structure* is locked; **exact model IDs per tier are chosen via eval at Phase 0 build start**. The model landscape shifts fast; locking specific IDs in a spec would create stale-on-arrival drift. The structure (5 tiers, 7 providers, AI Gateway routing) is stable.

**Classifier + embeddings**: Workers AI (native binding, zero egress) → Vectorize.

**Per-session override**: configurable by user; defaults per repo.

---

## 7. Agent stack

Three layers, each doing one job:

| Layer | Choice | Role |
|---|---|---|
| **In-sandbox harness** | OpenCode | The agentic loop: think, call tools, edit files, run tests. MCP-native server designed to be driven programmatically by an external control plane — exactly Forge's shape. |
| **Control-plane transport** | Cloudflare Agents SDK + Client SDK | DO-based stateful orchestration; WS hibernation; typed RPC; native presence + reconnection across browser refreshes. |
| **UI streaming** | Thin typed React rendering on Client SDK events | Hand-rolled but thin; consumes the Client SDK's typed event stream directly. No TanStack AI (AG-UI protocol bridge would be overhead for a closed internal platform). |

**Browser → DO path**: browsers cannot connect directly to a DO (CF security constraint). The path is **browser → Worker (auth proxy) → DO**. TanStack Start's Worker handles HTTP + app serving; a dedicated **session-gateway Worker** (service binding) handles the WS upgrade to the DO. Two Workers, one Pulumi deployment unit.

> See ADR-0004 for why TanStack AI and Flue were rejected.

---

## 8. Frontend

| Concern | Choice |
|---|---|
| Framework | **TanStack Start** (full-stack, type-safe, on CF Workers via Vite plugin) |
| Client state | **TanStack Store** + **TanStack Query** (server state) + **TanStack Form** |
| Components | **shadcn/ui** (Radix UI + Tailwind, copy-in, fully owned) |
| Styling | **Tailwind CSS v4** (Oxide engine, Rust-powered) |
| Charts | **Tremor** (dashboard-native, pairs with Tailwind/shadcn aesthetic) |
| Fonts | Inter + Space Grotesk (preserved from existing dashboard) |

> See ADR-0003 for why TanStack Start over Next.js.

---

## 9. Backend toolchain

| Concern | Choice |
|---|---|
| Package manager | **pnpm** (fast, disk-efficient, strict about phantom deps, monorepo workspaces) |
| Language | **TypeScript 7** (Go-native compiler, ~10× faster type-checks); **TS 6.x fallback** documented |
| Module resolution | Bundler resolution; type-check via tsc; build via Vite (web) + wrangler/esbuild (workers) |
| Lint | **Oxlint** (stable, ~40× faster than ESLint+Prettier) |
| Format | **Oxfmt** (beta, >95% Prettier compat); Prettier as fallback if it blocks |
| Unit / component tests | **Vitest** (Vite-native, Jest-compatible API) |
| Browser / E2E tests | **Playwright** |
| Strict mode | TypeScript strict throughout |

> See ADR-0006 for the TS 7 early-adoption rationale and fallback path.

---

## 10. Auth

| Surface | Choice |
|---|---|
| Forge Web front door | **Cloudflare Access** (Zero Trust) — policy enforcement, device posture, session management |
| Identity provider | **Google Workspace** — SAML/OIDC federation to Access; group claims; MFA |
| GitHub (org-level) | **GitHub App** installed on org/repos — read/clone/webhooks; bot comments/reviews; **cannot push/merge without human** |
| GitHub (per-user) | **Per-user GitHub OAuth** — used *only* for PR creation under that user's identity; stored encrypted (master key in Secrets Store) |

**Least privilege**: tools/MCPs have fine-grained scopes (read-only telemetry by default; write only via explicit allow). Git identity set per prompt/session (`user.name`/`user.email`) — no shared bot identity for commits.

---

## 11. Entry surfaces

**Slack** (primary entry): **Slack Bolt SDK on a Cloudflare Worker** (Events API for ingestion, Web API for posting; Receiver abstraction adapted for Workers).

Flow: Slack mention/reaction → Worker ingests + dedupes → classifier (Workers AI → Vectorize) routes to repo → control plane spawns Session → live updates posted back to the Slack thread.

**Web** (secondary entry / rich view): TanStack Start app behind Cloudflare Access.

---

## 12. Visual verification

Three sub-problems, each with a dedicated tool. **No VNC** (browser-native tools subsume it for Forge's use cases).

| Sub-problem | Tool | Why |
|---|---|---|
| Hosted code editor (human-driven) | **code-server** (in-sandbox, VS Code OSS in browser) | De facto; runs in the Sandbox container; optimized build |
| Agent visual verification of web apps | **Browser Run** (CF-native) | Live View, HITL breakpoints, session recordings, WebMCP, full CDP, 4× concurrency. Drives a specific app (Forge's use case), not browse-at-scale |
| Cached/repeatable deterministic actions | **Stagehand** (TS, on top of Browser Run's CDP) | Reliable "click X and verify Y" flows on the user's frontend; caches actions for cost |

**Integration seam**: Browser Run and Stagehand are exposed to OpenCode as **platform-provided MCP tools** (not registry-managed — see CONTEXT.md). Third-party MCP servers go through the registry governance (§13).

---

## 13. MCP & artifact governance

The registry decomposes into three problems; Forge adopts standards for two and builds only the third.

| Problem | Solution |
|---|---|
| **Discovery** | Federate the **official MCP Registry** (sync public servers to D1); D1 for private servers. One catalog, two sources. |
| **Packaging** | **OCI artifacts** (cosign-signed, digest-pinned) in **GHCR** (GitHub Container Registry — company is GitHub-centric), bundled via **KitOps ModelKits** (MCP server + skills + config + SBOM in one signed versioned artifact). |
| **Governance** (the Forge layer) | **D1-backed policy service**: per-repo enable lists, permission manifests (enforced by Outbound Workers Boundary), OpenSSF Scorecard gating (min score for inclusion), Trivy scan at registration, cosign verification at spawn. |

**Unification**: MCP servers AND sandbox images share one artifact-governance pipeline — they're the same shape of artifact. The cosign signing, Trivy scanning, Scorecard gating, and Chainguard bases locked in §15 all plug in here.

> See ADR-0007.

---

## 14. Observability

**OpenTelemetry SDK** emits spans throughout: Workers, DOs, Sandbox, AI Gateway, Browser Run, MCP tool calls.

**Backend**: **ClickHouse Cloud + ClickStack** (OTel-native ingest; traces + metrics + logs as wide events).

**Dashboards**: **Grafana** with the ClickHouse datasource plugin.

**Tempo, Loki, and Prometheus are dropped.** One OLAP store replaces three. Observability and the analytics lake are unified (an OTel span and an analytics event are the same fact).

> See ADR-0002.

---

## 15. Supply chain

Layered defense-in-depth. No single vendor covers all five surfaces (especially provenance signing), so each tool is used where it's strongest, orchestrated as GitHub Actions gates.

| Surface | Tool |
|---|---|
| Forge's own deps | **Dependabot** + `pnpm audit` (CI gate) |
| Secret/code scanning in Forge repos | **GitHub Advanced Security (GHAS)** |
| Sandbox base images | **Chainguard Images** (zero-CVE by construction) |
| Image + per-repo dep scanning + SBOM | **Trivy** (CI gate) + **Syft** (CycloneDX SBOMs → R2) |
| Image signing + provenance | **Sigstore cosign** + **Rekor** transparency log (verified at CF Sandbox spawn) |
| MCP registry risk scoring | **OpenSSF Scorecard** (min score for inclusion) |

**The "rogue image" failure mode (March 2026 Claude Code incident shape) is prevented by construction**: images must be cosign-signed by the build pipeline and CF verifies the signature at spawn. A tampered image cannot run.

---

## 16. IaC / CI/CD / secrets

| Concern | Choice |
|---|---|
| Infrastructure-as-Code | **Pulumi** (TS-native; CF provider for all CF resources + ClickHouse Cloud + Grafana Cloud) |
| Repo CI (lint/typecheck/test/build) | **GitHub Actions** |
| Worker / Web deploy | **CF Workers Builds** (native to CF, triggers on push, deploys via wrangler) |
| External infra deploy | IaC pipeline (Pulumi) in GitHub Actions |
| Secrets source of truth | **Cloudflare Secrets Store** (unified — control-plane Worker bindings, user-OAuth master key, repo-defined secrets) |
| Secrets delivery to sandboxes | **Sandbox Outbound Workers** boundary (creds injected at the network edge; agent never holds them) |

---

## 17. Cost control

| Mechanism | Implementation |
|---|---|
| Per-session/user/team budgets | **DO SQLite cost counters** (incremental, checked synchronously before each model call) |
| Per-request cost data | **AI Gateway** (native cost attribution per request) |
| Quota store | **D1** (per-team daily/weekly limits) |
| Anomaly detection | **ClickHouse** query → **Grafana** alert (daily spend > threshold, sudden spike) |
| Kill-switch | **KV flag** checked synchronously before every model call (platform-wide pause without redeploy) |

All-CF, no extra vendor.

---

## 18. Open items / deferred

These are **deliberate deferrals**, documented so future readers don't think they were forgotten:

| Item | Status | Trigger to resolve |
|---|---|---|
| **Exact model IDs per tier** | Deferred | Eval at Phase 0 build start (tier *structure* is locked; illustrative IDs in §6 are current as of Jun 2026) |
| **CF Artifacts** (git-compatible agent branch storage) | Candidate (Beta) | Pilot validation — does it replace pushing to real GitHub repos for agent work? Pricing/limits unpublished; resolve before production dependency |
| **CF Agent Memory** (managed persistent memory) | Candidate (Beta) | Pilot validation — does its managed recall/forget semantics beat hand-rolling memory in DO/D1 for our use case? Pricing/limits unpublished |
| **CF Sandbox snapshot/restore speed** | Pending verification | Backups API exists (copy-on-write overlays) but no published ms benchmark. Phase 0 spike: measure restore time vs Modal. If it falls short for warm starts, the Daytona failover weighting shifts from "documented" to "built" |
| **CF Sandbox isolation substrate** | Pending verification | Cloudflare claims "VM-level isolation" but does **not** publicly name the microVM (Firecracker/gVisor/custom). If a regulated auditor requires a named substrate, escalate to Cloudflare for a written attestation before production |
| **Z.ai + Kimi via AI Gateway** | Integration risk | Neither is a native AI Gateway provider ID — they route via the "openai-compatible" escape hatch, which has a known `/v1` prepend quirk (cloudflare/ai#476). Verify the gateway version resolves it before depending on these providers for production traffic |
| **Anthropic token/cost parsing in AI Gateway** | Known issue | Community reports the Gateway has trouble parsing Anthropic's `usage` object for token counts/cost in some cases. Verify cost-tracking accuracy for Anthropic traffic; may need a sidecar reconciliation |
| **Unweight** | **Not applicable** | CF Research/internal infra. Only benefits Workers AI-hosted inference (Cloudflare must hold the weights to compress them). **Does NOT help** with inference routed to external providers via AI Gateway. No knob to turn; no Forge action. Listed here only to prevent future re-investigation |

---

## How to read this doc alongside the others

- **`CONTEXT.md`** (root) — glossary. If a term here is fuzzy, check there.
- **`docs/adr/`** — the 7 surprising decisions in depth (rationale + rejected alternatives + consequences).
- **`03_Architecture.md`** — system architecture, mermaid diagrams, ERD. Still valid in structure; vendor nouns updated to match this doc.
- **`05_Security_Ops_Observability.md`** — security model, threat mitigations. Updated to reference CF Sandbox + Outbound Workers + the audit pipeline here.
- **`07_Implementation_Roadmap.md`** — phases and timeline. Updated to reference the locked toolchain.
- **`01_PRD.md` / `02_User_Stories.md` / `04_Interface_Design.md` / `06_Adversarial_Review.md`** — product requirements, user stories, UX, adversarial review. Largely tool-agnostic; scanned for contradicting nouns.
