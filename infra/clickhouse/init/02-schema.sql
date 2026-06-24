-- forge.session_event — sanitized analytics copy (docs/12 §5, mirrors
-- @forge/domain SESSION_EVENT_DDL verbatim — single source of truth).
-- Populated by Pipelines / the local OTel exporter (not the OTel collector's
-- auto tables). Raw 90 days; aggregates (the MV below) live longer.
CREATE TABLE IF NOT EXISTS forge.session_event (
  event_id String,
  session_id String,
  ts DateTime64(3),
  repo_id String,
  user_id String,
  event_type LowCardinality(String),
  status LowCardinality(String),
  activity LowCardinality(String),
  actor_id String,
  payload String,
  model LowCardinality(String),
  cost_usd Decimal(10,6),
  tokens_in UInt32,
  tokens_out UInt32,
  trace_id String,
  span_id String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (session_id, ts)
TTL toDateTime(ts) + INTERVAL 90 DAY;

-- Per-session outcome rollup (docs/12 §5 example MV). For "cost per merged PR"
-- queries (docs/01 §3 leading indicator). The session_final view is a stand-in
-- for terminal sessions; widen during pilot from real query patterns.
CREATE TABLE IF NOT EXISTS forge.session_outcome_daily_table (
  repo_id String,
  primary_model LowCardinality(String),
  outcome LowCardinality(String),
  day Date,
  session_count UInt64,
  total_cost Decimal(10,6),
  avg_cost Decimal(10,6),
  total_tokens UInt64
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (repo_id, primary_model, outcome, day);
