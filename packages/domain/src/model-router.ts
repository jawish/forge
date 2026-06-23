// Model router — 5-tier selection + fallback (docs/08 §6, docs/01 §3, §9 Phase 2).
// The tier STRUCTURE is locked; exact model IDs are chosen via eval at Phase 0
// (docs/08 §18). This module picks a model by tier + provider routing through the
// AI Gateway, with fallback to the next provider/tier on failure.
//
// Pure logic; the AI Gateway call is the real surface (§6.4). This is the
// decision layer the agent loop + cost control consult.

/** The 5 routing tiers (docs/08 §6). */
export type ModelTier =
  | "frontier" // tier 1 — complex multi-step planning, architecture
  | "default" // tier 2 — workhorse for most sessions
  | "flex" // tier 3 — cheap background, summarization, title gen
  | "specialist" // tier 4 — coding specialist when the default isn't best
  | "classifier"; // tier 5 — token-light routing + embeddings

/** A model entry in the routing table. */
export interface ModelEntry {
  /** The model id passed to the AI Gateway (e.g. 'claude-sonnet-4-6'). */
  id: string;
  tier: ModelTier;
  /** Relative preference within the tier (lower = preferred). */
  preference: number;
  /** Approx input $/1M tokens (for cost estimates; the Gateway gives exact). */
  costInPerMTok?: number;
  /** Approx output $/1M tokens. */
  costOutPerMTok?: number;
}

/** A routing decision: the chosen model + the fallback chain. */
export interface RoutingDecision {
  model: ModelEntry;
  /** Fallbacks tried in order if the chosen model's provider fails (docs/08 §6). */
  fallbacks: ModelEntry[];
}

/**
 * The model routing table. Tier structure locked (docs/08 §6); exact IDs are
 * chosen via eval (§7.3) — these are the documented illustrative defaults.
 * Widen/retune at pilot from real cost + quality data (the data flywheel).
 */
export const MODEL_ROUTING_TABLE: ReadonlyArray<ModelEntry> = [
  // Tier 1 — frontier reasoning.
  { id: "claude-opus-4-8", tier: "frontier", preference: 1, costInPerMTok: 5, costOutPerMTok: 25 },
  { id: "gpt-5.5", tier: "frontier", preference: 2, costInPerMTok: 1.25, costOutPerMTok: 10 },
  // Tier 2 — default coding (the workhorse).
  { id: "claude-sonnet-4-6", tier: "default", preference: 1, costInPerMTok: 3, costOutPerMTok: 15 },
  { id: "gemini-3.5-flash", tier: "default", preference: 2, costInPerMTok: 1.5, costOutPerMTok: 9 },
  // Tier 3 — flex / cheap background.
  {
    id: "gemini-3.1-flash-lite",
    tier: "flex",
    preference: 1,
    costInPerMTok: 0.25,
    costOutPerMTok: 1.5,
  },
  { id: "claude-haiku-4.5", tier: "flex", preference: 2, costInPerMTok: 1, costOutPerMTok: 5 },
  // Tier 4 — coding specialist.
  { id: "glm-4.6", tier: "specialist", preference: 1, costInPerMTok: 0.6, costOutPerMTok: 2.2 },
  { id: "grok-build-0.1", tier: "specialist", preference: 2, costInPerMTok: 1, costOutPerMTok: 2 },
  // Tier 5 — classifier / router (token-light).
  { id: "gpt-5-nano", tier: "classifier", preference: 1, costInPerMTok: 0.05, costOutPerMTok: 0.4 },
];

/** All models in a tier, sorted by preference. */
export function modelsForTier(tier: ModelTier): ModelEntry[] {
  return MODEL_ROUTING_TABLE.filter((m) => m.tier === tier).sort(
    (a, b) => a.preference - b.preference,
  );
}

/**
 * Route to a model for a tier + build the fallback chain (docs/08 §6).
 * The chosen model is the tier's top preference; fallbacks are the rest of the
 * tier, then the fallback tier's models. The AI Gateway does the actual provider
 * failover; this is the decision layer.
 */
export function routeModel(opts: {
  tier: ModelTier;
  /** Fallback tier if the primary tier is exhausted (docs/13 §2 model.fallback_tier). */
  fallbackTier?: ModelTier;
}): RoutingDecision {
  const primary = modelsForTier(opts.tier);
  if (primary.length === 0) {
    throw new Error(`no models configured for tier: ${opts.tier}`);
  }
  const [chosen, ...restOfTier] = primary;
  const fallbacks: ModelEntry[] = [...restOfTier];
  if (opts.fallbackTier && opts.fallbackTier !== opts.tier) {
    fallbacks.push(...modelsForTier(opts.fallbackTier));
  }
  return { model: chosen!, fallbacks };
}

/** Estimate the cost of a model call (docs/08 §17 — pre-call budget check). */
export function estimateCallCost(opts: {
  model: ModelEntry;
  tokensIn: number;
  tokensOut: number;
}): number {
  const inCost = opts.model.costInPerMTok
    ? (opts.tokensIn / 1_000_000) * opts.model.costInPerMTok
    : 0;
  const outCost = opts.model.costOutPerMTok
    ? (opts.tokensOut / 1_000_000) * opts.model.costOutPerMTok
    : 0;
  return inCost + outCost;
}

/** Map a repo config fallback_tier value to a ModelTier (docs/13 §2). */
export function tierFromConfig(value: string): ModelTier {
  switch (value) {
    case "frontier":
      return "frontier";
    case "default":
      return "default";
    case "flex":
      return "flex";
    case "specialist":
      return "specialist";
    default:
      return "flex"; // docs/13 §2 default
  }
}
