// OTel conventions — the forge.* namespace, service names, span names, and the
// ClickHouse session_event DDL (docs/14, docs/12 §5). Convention consistency is
// what makes the analytics flywheel work — these constants are the single source.

/** `forge.*` custom attribute names (docs/14 §1). Stable strings — never interpolate. */
export const ATTR = {
  /** On every span within a session. */
  SESSION_ID: "forge.session.id",
  REPO_ID: "forge.repo.id",
  USER_ID: "forge.user.id",
  /** Lifecycle status (docs/11 §2). */
  SESSION_STATUS: "forge.session.status",
  /** Sub-activity when status=active (docs/11 §3). */
  SESSION_ACTIVITY: "forge.session.activity",
  /** Sampling tier (docs/14 §4): 'full' | 'skeleton'. */
  SESSION_SAMPLED: "forge.session.sampled",
  /** Per-operation cost where applicable. */
  COST_USD: "forge.cost.usd",
  COST_TOKENS_IN: "forge.cost.tokens_in",
  COST_TOKENS_OUT: "forge.cost.tokens_out",
  /** Distinct from gen_ai.request.model (provider-side). */
  MODEL_ID: "forge.model.id",
  /** Which MCP server a tool belongs to. */
  MCP_SERVER: "forge.mcp.server",
  /** Error category (docs/15 §2) on error spans. */
  ERROR_CATEGORY: "forge.error.category",
  /** Optional domain code (docs/15 §3). */
  ERROR_CODE: "forge.error.code",
} as const;

/** Sampling tiers (docs/14 §4). */
export const SAMPLED = {
  FULL: "full" as const,
  SKELETON: "skeleton" as const,
};
export type SamplingTier = (typeof SAMPLED)[keyof typeof SAMPLED];

/** service.name values (docs/14 §2) — one per deployable unit. */
export const SERVICE = {
  CONTROL_PLANE: "forge-control-plane",
  WEB: "forge-web",
  SANDBOX: "forge-sandbox",
  PIPELINES: "forge-pipelines",
} as const;
export type ServiceName = (typeof SERVICE)[keyof typeof SERVICE];
