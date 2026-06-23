# Forge — Data Schemas

**Status**: Authoritative DDL/DML shape for all stores. Derived from the ERD in `03_Architecture.md` §4 + the state model in `11_State_Model.md` + the data-layer decisions in `08_Tech_Stack.md` §4.
**Companion docs**: `11_State_Model.md` (status/activity semantics), `10_API_Contracts.md` (DO API).

> The data layer has four stores, each serving a distinct access pattern (see `08` §4). This doc pins the concrete schema for each, plus the DO API surface and migration strategy.

---

## 1. Data-flow recap (one-way)

```
DO SQLite (source of truth, hot per-session state)
    │
    ├──→ D1          (derived index — session list, repo registry, settings, MCP catalog)
    ├──→ R2          (blobs + WORM audit — append-only via Pipelines)
    └──→ ClickHouse  (derived analytics — sanitized event stream, queryable lake)
```

**No store writes back to DO.** DO → (D1, R2, ClickHouse) is one-way.

---

## 2. DO SQLite — hot per-session state (source of truth)

Lives inside the `SessionDO`. One SQLite DB per active session. This is the authoritative live state; everything else is derived.

```sql
-- Session metadata (singleton row, id = DO id)
CREATE TABLE session_meta (
  id TEXT PRIMARY KEY,                -- session id (= DO id)
  repo_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  parent_session_id TEXT,             -- null for root; set for sub-sessions
  root_session_id TEXT NOT NULL,      -- = id for roots; ancestry chain
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'active', 'ready_for_pr', 'pr_open',
    'merged', 'closed', 'no_change', 'failed', 'cancelled'
  )),
  activity TEXT CHECK (activity IS NULL OR activity IN (
    'provisioning', 'running', 'awaiting_input', 'paused', 'stuck'
  )),
  -- activity is NULL when status !== 'active' (enforced in DO code, not just CHECK)
  primary_model TEXT,                 -- e.g., 'claude-sonnet-4-6'
  sandbox_image_version TEXT,
  sandbox_id TEXT,                    -- CF Sandbox instance id (null until provisioned)
  pr_url TEXT,
  pr_number INTEGER,
  created_at INTEGER NOT NULL,        -- unix ms
  ended_at INTEGER,
  merged_at INTEGER,
  total_cost_usd REAL DEFAULT 0,
  total_tokens_in INTEGER DEFAULT 0,
  total_tokens_out INTEGER DEFAULT 0,
  budget_limit_usd REAL,              -- per-session cap (null = inherit team default)
  outcome TEXT,                       -- set on terminal transition: 'merged'|'closed'|'no_change'|'failed'|'cancelled'
  failure_reason TEXT
);

-- Status transition log (append-only, for replay/debugging)
CREATE TABLE status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_status TEXT,
  to_status TEXT NOT NULL,
  from_activity TEXT,
  to_activity TEXT,
  ts INTEGER NOT NULL,
  reason TEXT,                        -- 'human_approve' | 'budget_exhausted' | 'stuck_timeout' | ...
  actor_id TEXT NOT NULL              -- user id or 'system'
);
CREATE INDEX idx_status_history_ts ON status_history(ts);

-- Prompts (the atomic unit of agent input)
CREATE TABLE prompt (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  user_id TEXT,                       -- null for system/agent-internal prompts
  prompt_type TEXT NOT NULL CHECK (prompt_type IN ('user', 'agent_internal', 'system')),
  content TEXT NOT NULL,              -- redacted copy for storage; raw in memory only
  model_params_json TEXT NOT NULL,    -- {model, reasoning, temperature} snapshot for this turn
  tokens_in INTEGER,
  tokens_out INTEGER,
  context_snapshot_json TEXT          -- recent history + git SHA + dirty state summary
);
CREATE INDEX idx_prompt_ts ON prompt(ts);

-- Tool calls (finest-grained unit of agent behavior)
CREATE TABLE tool_call (
  id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL REFERENCES prompt(id),
  ts INTEGER NOT NULL,
  tool_name TEXT NOT NULL,            -- 'read_file' | 'rg' | 'run_tests' | MCP tool name | ...
  args_json TEXT NOT NULL,            -- sanitized (secrets redacted)
  result_json TEXT,                   -- sanitized
  error_details_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'error', 'timeout', 'cancelled')),
  duration_ms INTEGER,
  exit_code INTEGER,
  retry_count INTEGER DEFAULT 0,
  tokens_in INTEGER,
  tokens_out INTEGER
);
CREATE INDEX idx_tool_call_prompt ON tool_call(prompt_id);
CREATE INDEX idx_tool_call_ts ON tool_call(ts);

-- Artifacts (durable outputs: diffs, screenshots, reports, review critiques)
CREATE TABLE artifact (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('diff', 'test_result', 'screenshot', 'telemetry', 'report', 'review_critique')),
  storage_uri TEXT NOT NULL,          -- R2 URI (blobs live in R2, not DO)
  generated_by TEXT NOT NULL CHECK (generated_by IN ('agent', 'user', 'review_agent')),
  mime_type TEXT,
  size_bytes INTEGER,
  metadata_json TEXT
);
CREATE INDEX idx_artifact_ts ON artifact(ts);

-- Cost ledger (incremental, for synchronous budget enforcement)
CREATE TABLE cost_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('model', 'sandbox_cpu', 'sandbox_egress', 'browser_run', 'other')),
  cost_usd REAL NOT NULL,
  tokens_in INTEGER,                  -- null for non-model sources
  tokens_out INTEGER,
  model TEXT,                         -- null for non-model sources
  detail_json TEXT                    -- provider, gateway request id, etc.
);
CREATE INDEX idx_cost_event_ts ON cost_event(ts);
```

### DO API surface (the methods control plane calls — seam 2 in `10`)

```ts
interface SessionDO {
  // Lifecycle
  spawn(input: { repoId, branch, createdByUserId, parentSessionId?, budgetLimitUsd?, primaryModel? }): Promise<{ sessionId }>
  transitionTo(to: { status?: SessionStatus, activity?: SessionActivity }, reason: string): Promise<{ from, to }>
  cancel(reason: CancelReason): Promise<void>

  // Prompts + streaming
  submitPrompt(input: { userId, content, modelParams? }): Promise<{ promptId }>
  pause(): Promise<void>
  resume(): Promise<void>

  // Reads
  getStatus(): Promise<{ status, activity, costUsd, tokensIn, tokensOut, ... }>
  getHistory(opts: { sinceTs?, limit? }): Promise<{ prompts, toolCalls, artifacts }>

  // Agent callbacks (seam 5 — MCP tools call these)
  reportStatus(status: { activity, summary }): Promise<void>
  createArtifact(artifact: ArtifactInput): Promise<{ artifactId }>
  requestHumanInput(question: string): Promise<void>
  completePR(changes: { diffSummary, commitSha }): Promise<void>
}
```

---

## 3. D1 — control-plane OLTP (derived index)

The globally-queryable index. Populated by the control plane as a *projection* of DO state (eventually consistent). This is what the dashboard lists/searches/filter.

```sql
-- Sessions (projection of session_meta across all DOs)
CREATE TABLE session (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  parent_session_id TEXT,
  root_session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  activity TEXT,
  primary_model TEXT,
  sandbox_image_version TEXT,
  pr_url TEXT,
  pr_number INTEGER,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  merged_at INTEGER,
  total_cost_usd REAL DEFAULT 0,
  total_tokens_in INTEGER DEFAULT 0,
  total_tokens_out INTEGER DEFAULT 0,
  outcome TEXT,
  failure_reason TEXT
);
CREATE INDEX idx_session_user_status ON session(created_by_user_id, status);
CREATE INDEX idx_session_repo_status ON session(repo_id, status);
CREATE INDEX idx_session_root ON session(root_session_id);
CREATE INDEX idx_session_created_at ON session(created_at DESC);

-- Repos (registry of onboarded repos)
CREATE TABLE repo (
  id TEXT PRIMARY KEY,
  github_org TEXT NOT NULL,           -- e.g., 'mycompany'
  github_repo TEXT NOT NULL,          -- e.g., 'monolith'
  default_branch TEXT NOT NULL DEFAULT 'main',
  image_config_json TEXT NOT NULL,    -- Dockerfile ref, setup scripts, base image
  tuning_json TEXT NOT NULL,          -- prewarm commands, MCP allowlist, model defaults, policy (11 §6)
  onboarding_status TEXT NOT NULL CHECK (onboarding_status IN ('pending', 'building', 'ready', 'failed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(github_org, github_repo)
);

-- Repo image versions (immutable, signed)
CREATE TABLE repo_image_version (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repo(id),
  version TEXT NOT NULL,              -- semver or commit-sha-derived
  git_sha TEXT NOT NULL,
  built_at INTEGER NOT NULL,
  build_status TEXT NOT NULL CHECK (build_status IN ('success', 'failed')),
  storage_ref TEXT NOT NULL,          -- GHCR digest
  signature_ref TEXT NOT NULL,        -- cosign signature / Rekor entry
  sbom_ref TEXT NOT NULL,             -- R2 URI to CycloneDX SBOM
  metrics_json TEXT,                  -- {cold_start_p95, cache_hit_rate, image_size_mb}
  UNIQUE(repo_id, version)
);
CREATE INDEX idx_image_version_repo ON repo_image_version(repo_id, built_at DESC);

-- Users (projection from Google Workspace via CF Access)
CREATE TABLE forge_user (
  id TEXT PRIMARY KEY,                -- stable id (sub from CF Access JWT)
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  github_oauth_token_encrypted TEXT,  -- null until first PR; master key in Secrets Store
  github_username TEXT,
  team_id TEXT,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER
);

-- Teams (for budgets, quotas, access scoping)
CREATE TABLE team (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  budget_limit_usd_daily REAL,
  budget_limit_usd_weekly REAL,
  created_at INTEGER NOT NULL
);

-- MCP catalog (federated from official MCP Registry + private entries)
CREATE TABLE mcp_server (
  id TEXT PRIMARY KEY,                -- 'memory' | 'linear' | 'forge-internal-foo' | ...
  display_name TEXT NOT NULL,
  description TEXT,
  source TEXT NOT NULL CHECK (source IN ('registry_federated', 'private')),
  oci_ref TEXT NOT NULL,              -- GHCR digest (cosign-signed)
  signature_ref TEXT NOT NULL,
  scorecard_score REAL,               -- OpenSSF Scorecard (null for private)
  permission_manifest_json TEXT NOT NULL,
  version TEXT NOT NULL,
  registered_at INTEGER NOT NULL
);

-- Per-repo MCP enable list (governance — ADR-0007)
CREATE TABLE repo_mcp_enable (
  repo_id TEXT NOT NULL REFERENCES repo(id),
  mcp_server_id TEXT NOT NULL REFERENCES mcp_server(id),
  enabled_by_user_id TEXT NOT NULL,
  enabled_at INTEGER NOT NULL,
  config_json TEXT,                   -- per-repo MCP config overrides
  PRIMARY KEY (repo_id, mcp_server_id)
);

-- Automations (cron / alert-triggered sessions)
CREATE TABLE automation (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repo(id),
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('cron', 'webhook', 'github_event')),
  trigger_config_json TEXT NOT NULL,  -- cron expr, webhook source, GH event filter
  prompt_template TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  created_at INTEGER NOT NULL
);

-- Quota counters (for cost control — 08 §17)
CREATE TABLE quota_counter (
  scope TEXT NOT NULL CHECK (scope IN ('user', 'team', 'session')),
  scope_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly')),
  period_key TEXT NOT NULL,           -- '2026-06-23' etc.
  cost_usd REAL DEFAULT 0,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  PRIMARY KEY (scope, scope_id, period, period_key)
);
```

### D1 migration strategy

- **Migrations** via `wrangler d1 migrations` — SQL files versioned in `apps/control-plane/migrations/`.
- **Apply on deploy** (CF Workers Builds runs `wrangler d1 migrations apply` as a pre-deploy step).
- **Backward-compatible migrations only** in prod (add column → backfill → later drop old). Schema-breaking changes are multi-deploy.

---

## 4. R2 — blobs + WORM audit

### Blob buckets

| Bucket | Contents | Lifecycle |
|---|---|---|
| `forge-artifacts` | Session artifacts (diffs, screenshots, reports) | Retain per session retention; delete on session purge |
| `forge-sandboxes` | Sandbox snapshots (Backups API output) | Short TTL (warm pool); delete on session terminal |
| `forge-sboms` | CycloneDX SBOMs per image build | Long retention (compliance) |
| `forge-audit` | **Audit events (Object Lock Compliance mode)** | Retention per compliance policy (e.g., 7 years) |

### Audit event object shape (one JSONL object per event)

```json
{
  "event_id": "evt_abc123",
  "session_id": "sess_xyz",
  "ts": 1719100000000,
  "actor_id": "user_123",
  "actor_type": "user|system|agent",
  "action": "prompt|tool_call|edit|commit|pr_create|policy_change|status_transition",
  "target": { "type": "file|repo|pr|mcp|session", "id": "..." },
  "before_json": "...",           // null for creates
  "after_json": "...",
  "correlation_id": "...",        // OTel trace id for cross-referencing
  "prev_hash": "...",             // Merkle chain link
  "this_hash": "..."              // sha256(this_event_canonical_json || prev_hash)
}
```

Stored as date-partitioned keys: `audit/yyyy/mm/dd/HH/<event_id>.json`. Object Lock Compliance mode prevents deletion/modification within retention.

---

## 5. ClickHouse — analytics lake + observability

### Session event table (sanitized analytics copy)

```sql
CREATE TABLE forge.session_event (
  event_id String,
  session_id String,
  ts DateTime64(3),
  repo_id String,
  user_id String,
  event_type LowCardinality(String),    -- 'session_started'|'prompt'|'tool_call'|'artifact'|'status_transition'|'cost_event'|...
  status LowCardinality(String),        -- session status at event time
  activity LowCardinality(String),      -- nullable
  actor_id String,
  -- Payload (sanitized — secrets/PII redacted before insert via Pipelines transform)
  payload String,                       -- JSON, already sanitized
  -- Denormalized for fast group-by analytics
  model LowCardinality(String),
  cost_usd Decimal(10,6),
  tokens_in UInt32,
  tokens_out UInt32,
  -- OTel correlation
  trace_id String,
  span_id String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (session_id, ts)
TTL ts + INTERVAL 90 DAY;              -- raw 90 days; aggregates live longer (materialized views)
```

### OTel-native tables (via ClickStack ingest)

ClickStack creates the standard OTel tables (`otel_traces`, `otel_logs`, `otel_metrics`) automatically — no hand-written DDL. Forge just configures the OTel exporter to point at ClickStack.

### Materialized views (analytics flywheel)

Derived aggregate tables for the Ramp-style queries:

```sql
-- Per-session outcome rollup (for "cost per merged PR" queries)
CREATE MATERIALIZED VIEW forge.session_outcome_daily
REFRESH EVERY 1 HOUR TO forge.session_outcome_daily_table
AS SELECT
  repo_id, primary_model, outcome,
  count() as session_count,
  sum(total_cost_usd) as total_cost,
  avg(total_cost_usd) as avg_cost,
  sum(total_tokens_in + total_tokens_out) as total_tokens
FROM forge.session_final  -- a view of terminal sessions
GROUP BY repo_id, primary_model, outcome, toDate(ended_at);
```

(Other MVs: tool-failure-taxonomy, per-repo-latency, cost-by-tier — derived during pilot.)

---

## 6. KV — config cache + flags

KV is eventually consistent and low-latency. Use only for:

| Key pattern | Value | TTL |
|---|---|---|
| `config:repo:{repo_id}` | Cached repo config JSON | 5 min (refresh on update) |
| `flag:killswitch` | `'on' \| 'off'` | none (checked synchronously before every model call) |
| `flag:feature:{name}` | Feature flag value (Flagship-managed) | per-flag |
| `ratelimit:{user_id}:{window}` | Counter | window expiry |

**Never store source-of-truth data in KV** — it's a cache. Repo config source-of-truth is D1; KV just caches it for low-latency reads on the hot path.

---

## 7. Vectorize — classifier embeddings

One index: `forge-repo-classifier`.

- **Embedding model**: Workers AI (e.g., `@cf/baai/bge-base-en-v1.5`).
- **Documents**: per-repo descriptions, file-tree summaries, README excerpts, recent commit messages.
- **Metadata**: `{ repo_id, org, language, last_indexed_ts }`.
- **Query**: incoming prompt → embed → top-K nearest repos → classifier picks one (or asks user).

Re-indexed on repo onboarding + on significant changes (webhook-triggered).

---

## 8. Migration & evolution strategy

| Store | Migration tooling | Strategy |
|---|---|---|
| DO SQLite | Code-level (DO `migration` method on first access per session) | Sessions are ephemeral; schema can change between sessions without migration pain. Add a `schema_version` row; bump on change. |
| D1 | `wrangler d1 migrations` | Versioned SQL in `apps/control-plane/migrations/`. Backward-compatible only in prod. |
| ClickHouse | `ALTER TABLE` (online) | ClickHouse handles online schema evolution well; coordinated via the analytics pipeline deploy. |
| R2 audit | N/A (append-only schema) | Schema is the JSONL shape; evolving fields is additive (new keys OK; don't remove). |
| KV | N/A (cache, disposable) | Drop and rebuild on schema change. |
| Vectorize | Re-index job | Triggered on schema change; idempotent. |

---

## 9. What this doc does NOT specify

- **Sanitization pipeline details** (regex vs ML; what patterns) — Tier 2, load-bearing for analytics lake.
- **Concrete materialized views** beyond the example — derived during pilot from actual query patterns.
- **Retention policies per state** (how long `failed` vs `merged` sessions persist) — Tier 2.
- **Backup/restore strategy** — Tier 2 (D1 has managed backups; R2 Object Lock covers audit; ClickHouse Cloud has its own).
