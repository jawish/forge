-- D1 control-plane index (docs/12 §3). Globally-queryable projection of DO state.
-- Populated by the control plane as a one-way projection of session_meta across
-- all SessionDO instances (eventually consistent). This is what the dashboard
-- lists/searches/filters. The DO SQLite (docs/12 §2) remains the source of truth.

-- Sessions (projection of session_meta across all DOs).
CREATE TABLE IF NOT EXISTS session (
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

CREATE INDEX IF NOT EXISTS idx_session_user_status ON session(created_by_user_id, status);
CREATE INDEX IF NOT EXISTS idx_session_repo_status ON session(repo_id, status);
CREATE INDEX IF NOT EXISTS idx_session_root ON session(root_session_id);
CREATE INDEX IF NOT EXISTS idx_session_created_at ON session(created_at DESC);
