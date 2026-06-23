# Forge — Observability Conventions

**Version**: 1.0 (locked)
**Status**: Authoritative for OTel attribute names, span names, service names, and sampling strategy.
**Companion docs**: `08_Tech_Stack.md` §14 (ClickHouse + ClickStack + Grafana), `12_Data_Schemas.md` §5 (ClickHouse tables).

> Convention consistency is what makes the analytics flywheel work. If one engineer writes `session.id` and another writes `forge.session.id`, every ClickHouse join breaks. This doc pins the convention.

---

## 1. Attribute namespace

**`forge.*` prefix** for all custom attributes, layered on top of OTel semantic conventions:

| Attribute | Type | Example | Notes |
|---|---|---|---|
| `forge.session.id` | string | `sess_abc123` | On every span within a session |
| `forge.repo.id` | string | `repo_xyz` | |
| `forge.user.id` | string | `user_123` | The actor who triggered the work |
| `forge.session.status` | enum | `active`, `failed`, `merged` | Lifecycle status (11 §2) |
| `forge.session.activity` | enum | `running`, `paused`, `stuck` | Sub-activity when status=active (11 §3) |
| `forge.session.sampled` | enum | `full`, `skeleton` | Sampling tier (§4 below) |
| `forge.cost.usd` | double | `0.0042` | Per-operation cost where applicable |
| `forge.cost.tokens_in` | int | `1240` | |
| `forge.cost.tokens_out` | int | `820` | |
| `forge.model.id` | string | `claude-sonnet-4-6` | Distinct from `gen_ai.request.model` (provider-side) |
| `forge.mcp.server` | string | `linear` | Which MCP server a tool belongs to |
| `forge.error.category` | enum | `transient`, `budget_exhausted` | Error category (15 §2) on error spans |
| `forge.error.code` | string | `BUDGET_EXHAUSTED` | Optional domain code (15 §2) |

### OTel semantic conventions used as-is (no `forge.` prefix)

- `gen_ai.*` — model calls (OpenTelemetry GenAI conventions). Lets ClickStack's built-in GenAI dashboards work.
- `http.*`, `rpc.*` — HTTP/tRPC transport.
- `messaging.*` — Queues.
- Standard resource attributes: `service.name`, `service.version`, `environment`.

---

## 2. Service names (`service.name` resource attribute)

One per deployable unit:

| `service.name` | What |
|---|---|
| `forge-control-plane` | The control-plane Worker (API, WS gateway, Slack, DOs) |
| `forge-web` | The TanStack Start web Worker |
| `forge-sandbox` | Code running inside a CF Sandbox (OpenCode + tools) — emitted from within the sandbox |
| `forge-pipelines` | Pipelines transforms (sanitization, audit) |

Every span carries its emitter's `service.name`. This lets Grafana filter by "show me everything from the control plane" or "show me sandbox-side spans only."

---

## 3. Span naming

Operation-focused, dotted hierarchy:

| Span name | When |
|---|---|
| `session.spawn` | Session created (queued → active transition) |
| `session.transition` | Status/activity transition (11 §4-5) |
| `session.cancel` | Human cancels |
| `prompt.submit` | A prompt is submitted to a session |
| `prompt.stream` | Model streaming for a prompt (child of `prompt.submit`) |
| `tool.call` | A tool is invoked (child of `prompt.submit`) — `forge.mcp.server` distinguishes platform vs registry MCP |
| `artifact.create` | An artifact is produced |
| `sandbox.provision` | Sandbox booting |
| `sandbox.snapshot` | Snapshot to R2 |
| `sandbox.restore` | Warm-pool restore |
| `classifier.intent` | Slack intent classification |
| `classifier.route` | Slack repo routing |
| `sanitizer.redact` | A sanitization redaction pass |
| `pipeline.audit` | Audit event written to R2 |
| `boundary.egress` | An Outbound Workers egress call (allowed or denied) |

Span names are stable strings (low cardinality) — never interpolate IDs into span names (use attributes for cardinality).

---

## 4. Sampling — session-scoped head + status-aware promotion

Forge's traces are **session-scoped**, not request-scoped. This breaks conventional tail sampling (multi-hour session traces can't be buffered). The strategy:

### At session spawn (`session.spawn`)

Generate a session-level sampling token. Stored as `forge.session.sampled` on every span in the session:

- **`full`** (~20% of sessions, or 100% for high-sensitivity repos): emit all spans to ClickStack live.
- **`skeleton`** (~80%): emit only skeleton spans (`session.spawn`, `session.transition`, `session.cancel`, cost summary). Tool-call / prompt-stream spans are buffered in DO SQLite but NOT emitted live.

### At terminal transition (`session.transition` to `failed` / `closed`)

**Promote to full**: if the outcome is `failed` or `closed` (the learning signals), flush the DO-buffered spans to ClickStack. The DO has been writing all spans to its SQLite (`12` §2) regardless; promotion just means "emit the buffered ones now."

### Why this works

- **Failures always captured** (the flywheel's learning signal) — decided at the moment of failure, not after an infeasible multi-hour buffer.
- **Successes sampled** (cost control) — skeleton spans still give aggregate analytics.
- **No collector buffer** — the DO is the buffer (it already stores spans locally).
- **~3.6× span reduction** vs no-sampling, at 100% failure capture.

### Cost math (1000 sessions/day)

- 200 full + 800 skeleton × ~10 skeleton spans + ~5% promote-to-full = ~83k spans/day vs ~300k unsampled.

---

## 5. ClickStack ingest + tables

ClickStack creates standard OTel tables automatically (`otel_traces`, `otel_logs`, `otel_metrics`). No hand-written DDL for those.

Forge's custom `session_event` table (`12` §5) is populated by Pipelines (not the OTel exporter) for the analytics-flywheel queries. It's a denormalized, sanitized projection — see `18_Security_Contracts.md` for the sanitization contract.

---

## 6. Grafana dashboards

Built on ClickHouse datasources. Standard dashboards (built during Phase 0):

| Dashboard | Panels |
|---|---|
| **Session overview** | Active/queued/failed counts, p50/p99 TTI, cost per session |
| **Agent behavior** | Tool-call distribution, stuck-rate, model usage by tier |
| **Cost** | Spend per team/repo/model, budget-burn rate, anomaly alerts |
| **Reliability** | Error rate by category (15 §2), sandbox provisioning failures, provider errors |
| **Audit** | Session outcome rollup, PR-merge rate, no-change rate |

Dashboards filterable by `forge.repo.id`, `forge.user.id`, `forge.session.status`, `environment`.

---

## 7. Local dev

- **`fast` and `real` profiles** (09 §5): OTel exports to **console** (terminal). No ClickHouse/Grafana needed locally.
- Optional: local ClickHouse (Docker) + Grafana (Docker) for testing the pipeline end-to-end. Not required for normal dev.
