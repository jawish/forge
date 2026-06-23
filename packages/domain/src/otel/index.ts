// @forge/domain otel barrel — the forge.* namespace, span/service names,
// sampling tiers, and ClickHouse DDL (docs/14, docs/12 §5).

export { ATTR, SERVICE, SAMPLED } from "./attributes";
export type { ServiceName, SamplingTier } from "./attributes";
export { SPAN } from "./spans";
export type { SpanName } from "./spans";
export { SESSION_EVENT_DDL, SESSION_OUTCOME_DAILY_MV_DDL } from "./clickhouse";
