// D1 control-plane index migration (docs/12 §3). The D1 `session` table is a
// one-way projection of the DO session_meta (docs/12 §3). Applied at deploy via
// `wrangler d1 migrations apply` (migrations/0001_session_projection.sql) and
// on-demand via the /api/ops/init-db endpoint (for local dev + tests — miniflare
// doesn't auto-apply D1 migrations).

/** The D1 migration as individual statements. D1 exec runs one statement per call. */
export const D1_SESSION_MIGRATION_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS session (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_session_user_status ON session(created_by_user_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_session_repo_status ON session(repo_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_session_root ON session(root_session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_session_created_at ON session(created_at DESC)`,
];

/**
 * Apply the D1 session-projection migration. Idempotent (CREATE ... IF NOT EXISTS).
 * Used by /api/ops/init-db (local dev + tests) and ensureD1SessionTable (lazy).
 */
export async function applyD1Migration(db: D1Database): Promise<void> {
  for (const stmt of D1_SESSION_MIGRATION_STATEMENTS) {
    await db.prepare(stmt).run();
  }
}

/**
 * Lazy D1 migration guard. Checked before the router's first D1 access so the
 * `session` table exists without requiring a manual migration step. Idempotent +
 * cheap after the first call (just a flag flip). In production, `wrangler d1
 * migrations apply` handles this at deploy — this is a belt-and-suspenders for
 * local dev where miniflare doesn't auto-apply migrations.
 */
let d1SessionTableReady = false;

export async function ensureD1SessionTable(db: D1Database): Promise<void> {
  if (d1SessionTableReady) return;
  await applyD1Migration(db);
  d1SessionTableReady = true;
}
