// SessionDO SQLite schema (docs/12 §2). The migration runs on first access per
// session (code-level, via the DO's sql helper). A schema_version row tracks it.
//
// This is the source-of-truth hot state; D1/R2/ClickHouse are one-way projections.
// One SQLite DB per active session (CF Agents DOs are SQLite-backed).

export const SCHEMA_VERSION = 1;

/**
 * The migration as individual statements. CF DOs' sql.exec runs ONE statement
 * per call (multi-statement strings silently no-op beyond the first), so we split
 * and exec each. Tests assert each table exists after migration.
 */
export const SESSION_DO_MIGRATION_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS session_meta (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    branch TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL,
    parent_session_id TEXT,
    root_session_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'queued', 'active', 'ready_for_pr', 'pr_open',
      'merged', 'closed', 'no_change', 'failed', 'cancelled'
    )),
    activity TEXT CHECK (activity IS NULL OR activity IN (
      'provisioning', 'running', 'awaiting_input', 'paused', 'stuck'
    )),
    primary_model TEXT,
    sandbox_image_version TEXT,
    sandbox_id TEXT,
    pr_url TEXT,
    pr_number INTEGER,
    created_at INTEGER NOT NULL,
    ended_at INTEGER,
    merged_at INTEGER,
    total_cost_usd REAL DEFAULT 0,
    total_tokens_in INTEGER DEFAULT 0,
    total_tokens_out INTEGER DEFAULT 0,
    budget_limit_usd REAL,
    outcome TEXT,
    failure_reason TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_status TEXT,
    to_status TEXT NOT NULL,
    from_activity TEXT,
    to_activity TEXT,
    ts INTEGER NOT NULL,
    reason TEXT,
    actor_id TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_status_history_ts ON status_history(ts)`,
  `CREATE TABLE IF NOT EXISTS prompt (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    user_id TEXT,
    prompt_type TEXT NOT NULL CHECK (prompt_type IN ('user', 'agent_internal', 'system')),
    content TEXT NOT NULL,
    model_params_json TEXT NOT NULL,
    tokens_in INTEGER,
    tokens_out INTEGER,
    context_snapshot_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_prompt_ts ON prompt(ts)`,
  `CREATE TABLE IF NOT EXISTS tool_call (
    id TEXT PRIMARY KEY,
    prompt_id TEXT NOT NULL REFERENCES prompt(id),
    ts INTEGER NOT NULL,
    tool_name TEXT NOT NULL,
    args_json TEXT NOT NULL,
    result_json TEXT,
    error_details_json TEXT,
    status TEXT NOT NULL CHECK (status IN ('success', 'error', 'timeout', 'cancelled')),
    duration_ms INTEGER,
    exit_code INTEGER,
    retry_count INTEGER DEFAULT 0,
    tokens_in INTEGER,
    tokens_out INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tool_call_prompt ON tool_call(prompt_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_call_ts ON tool_call(ts)`,
  `CREATE TABLE IF NOT EXISTS artifact (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('diff', 'test_result', 'screenshot', 'telemetry', 'report', 'review_critique')),
    storage_uri TEXT NOT NULL,
    generated_by TEXT NOT NULL CHECK (generated_by IN ('agent', 'user', 'review_agent')),
    mime_type TEXT,
    size_bytes INTEGER,
    metadata_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_artifact_ts ON artifact(ts)`,
  `CREATE TABLE IF NOT EXISTS cost_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('model', 'sandbox_cpu', 'sandbox_egress', 'browser_run', 'other')),
    cost_usd REAL NOT NULL,
    tokens_in INTEGER,
    tokens_out INTEGER,
    model TEXT,
    detail_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cost_event_ts ON cost_event(ts)`,
  `CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agent_process (
    session_id TEXT NOT NULL,
    sandbox_id TEXT NOT NULL,
    process_id TEXT NOT NULL PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'running',
    exit_code INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION.toString()}')`,
];

/** The full migration as one string (for reference / docs; exec'd statement-by-statement at runtime). */
export const SESSION_DO_MIGRATION_SQL = SESSION_DO_MIGRATION_STATEMENTS.join(";\n\n");
