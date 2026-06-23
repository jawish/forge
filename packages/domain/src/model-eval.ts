// Model evaluation framework (docs/08 §18, §7.3). Picks the frontier /
// default-coding / flex / classifier tier IDs via a scored eval. The tier
// STRUCTURE is locked (docs/08 §6); the IDs are chosen at Phase 0 build start
// via this framework, recorded in an ADR (§7.3).
//
// Pure scoring logic; the model calls (running each test case) are injected ports.

import type { ModelTier } from "./model-router";

/** A single eval test case (a coding task with a known-good outcome). */
export interface EvalCase {
  id: string;
  prompt: string;
  /** The repo/context the task runs against. */
  repo?: string;
  /** Pass/fail criteria (e.g. 'tests green', 'diff matches intent'). */
  expected: string;
  /** Weight in the aggregate score (higher = more important). */
  weight?: number;
}

/** A model's result on one eval case. */
export interface EvalResult {
  caseId: string;
  passed: boolean;
  /** Duration in ms (for speed/cost tradeoff). */
  durationMs?: number;
  /** The cost in USD (for the cost dimension). */
  costUsd?: number;
  /** A quality score 0-1 (for partial-credit cases). */
  quality?: number;
}

/** A candidate model to evaluate. */
export interface EvalCandidate {
  modelId: string;
  tier: ModelTier;
}

/** The aggregate score for a candidate on the suite. */
export interface CandidateScore {
  modelId: string;
  tier: ModelTier;
  /** Weighted pass rate (0-1). */
  passRate: number;
  /** Mean quality (0-1). */
  meanQuality: number;
  /** Median duration (ms). */
  medianDurationMs?: number;
  /** Total cost across the suite. */
  totalCostUsd?: number;
  /** The composite score (higher = better for the tier). */
  composite: number;
}

/** Port: run a model on the eval suite, returning results per case. */
export type RunEvalSuite = (modelId: string, cases: EvalCase[]) => Promise<EvalResult[]>;

/**
 * Evaluate candidate models for a tier + rank them (docs/08 §18, §7.3).
 * The composite weights pass-rate + quality (correctness), penalizing cost + latency.
 * The winner is recorded as the tier's ID (in an ADR per §7.3).
 */
export async function evaluateTier(opts: {
  tier: ModelTier;
  candidates: EvalCandidate[];
  cases: EvalCase[];
  runSuite: RunEvalSuite;
  /** Cost weight in the composite (0-1; default 0.3 for flex tier, 0.1 for frontier). */
  costWeight?: number;
}): Promise<{ scores: CandidateScore[]; winner: CandidateScore }> {
  const scores: CandidateScore[] = [];
  for (const candidate of opts.candidates) {
    if (candidate.tier !== opts.tier) continue;
    const results = await opts.runSuite(candidate.modelId, opts.cases);
    scores.push(
      scoreCandidate(
        candidate,
        results,
        opts.cases,
        opts.costWeight ?? defaultCostWeight(opts.tier),
      ),
    );
  }
  scores.sort((a, b) => b.composite - a.composite);
  if (scores.length === 0) throw new Error(`no candidates for tier ${opts.tier}`);
  return { scores, winner: scores[0]! };
}

/** Score a candidate from its per-case results (weighted pass rate + quality - cost penalty). */
export function scoreCandidate(
  candidate: EvalCandidate,
  results: EvalResult[],
  cases: EvalCase[],
  costWeight: number,
): CandidateScore {
  const qualityWeight = 1 - costWeight;
  let totalWeight = 0;
  let weightedPass = 0;
  let weightedQuality = 0;
  let totalCost = 0;
  const durations: number[] = [];

  for (const result of results) {
    const c = cases.find((c) => c.id === result.caseId);
    const w = c?.weight ?? 1;
    totalWeight += w;
    weightedPass += (result.passed ? 1 : 0) * w;
    weightedQuality += (result.quality ?? (result.passed ? 1 : 0)) * w;
    if (result.costUsd) totalCost += result.costUsd;
    if (result.durationMs) durations.push(result.durationMs);
  }

  const passRate = totalWeight > 0 ? weightedPass / totalWeight : 0;
  const meanQuality = totalWeight > 0 ? weightedQuality / totalWeight : 0;
  const medianDurationMs = durations.length > 0 ? median(durations) : undefined;

  // Composite: quality-weighted score minus a cost penalty (normalized).
  // Cost penalty: 0 at $0, scales linearly with total cost up to costWeight.
  // Uses a fixed reference ($0.50 across a 3-case suite) so cheaper candidates
  // genuinely rank higher (not relative to their own cost).
  const COST_REFERENCE = 0.5;
  const costPenalty = costWeight * Math.min(totalCost / COST_REFERENCE, 1);
  const composite = qualityWeight * (0.5 * passRate + 0.5 * meanQuality) - costPenalty;

  return {
    modelId: candidate.modelId,
    tier: candidate.tier,
    passRate,
    meanQuality,
    medianDurationMs,
    totalCostUsd: totalCost > 0 ? totalCost : undefined,
    composite,
  };
}

/** Default cost weight per tier (frontier cares less about cost; flex cares a lot). */
function defaultCostWeight(tier: ModelTier): number {
  switch (tier) {
    case "frontier":
      return 0.1;
    case "default":
      return 0.2;
    case "flex":
      return 0.4;
    case "specialist":
      return 0.2;
    case "classifier":
      return 0.3;
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
