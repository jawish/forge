// ClickHouse DDL — the sanitized analytics session_event table (docs/12 §5).
// Populated by Pipelines (not the OTel exporter). Denormalized + sanitized
// projection for the analytics-flywheel queries (docs/14 §5). OTel-native
// tables (otel_traces/logs/metrics) are created automatically by ClickStack.

/**
 * forge.session_event — sanitized analytics copy. Raw 90 days; aggregates
 * (materialized views) live longer. See docs/12 §5.
 */
export const SESSION_EVENT_DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS forge.session_event (
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
TTL toDateTime(ts) + INTERVAL 90 DAY;  -- raw 90 days (DateTime64 → cast for TTL)
`;

/**
 * Per-session outcome rollup MV (docs/12 §5). For "cost per merged PR" queries.
 * Derived during pilot from actual query patterns; this is the seeded example.
 */
export const SESSION_OUTCOME_DAILY_MV_DDL = /* sql */ `
CREATE MATERIALIZED VIEW IF NOT EXISTS forge.session_outcome_daily
REFRESH EVERY 1 HOUR TO forge.session_outcome_daily_table
AS SELECT
  repo_id, primary_model, outcome,
  count() as session_count,
  sum(total_cost_usd) as total_cost,
  avg(total_cost_usd) as avg_cost,
  sum(total_tokens_in + total_tokens_out) as total_tokens
FROM forge.session_final  -- a view of terminal sessions
GROUP BY repo_id, primary_model, outcome, toDate(ended_at);
`;
