// Cost control v1 (docs/08 §17, checklist §8.4).
// Three mechanisms:
// 1. DO SQLite cost counters — incremental, checked SYNCHRONOUSLY before each
//    model call against the per-session budget (docs/11 §6 policy.budget_limit_usd).
// 2. KV kill-switch — `flag:killswitch` checked synchronously before every model
//    call (platform-wide pause without redeploy).
// 3. AI Gateway per-request cost attribution (§6/prod).
//
// This module holds the pure budget-check logic (testable). The DO holds the
// counters; the kill-switch lives in KV.

import type { CostSource } from "../types/session";

/** A cost event ready to append to the DO cost_event table. */
export interface CostEntry {
  ts: number;
  source: CostSource;
  costUsd: number;
  tokensIn: number | null;
  tokensOut: number | null;
  model: string | null;
  detailJson: string | null;
}

/** Result of a pre-call budget check. */
export interface BudgetCheckResult {
  allowed: boolean;
  /** Reason when disallowed (for the ForgeError / Slack thread). */
  reason?: string;
  /** Running total after this call would be applied. */
  projectedTotalUsd: number;
  /** The session budget (null = inherit team default — treated as unlimited here). */
  budgetLimitUsd: number | null;
}

/**
 * Check whether a model call is within budget (docs/08 §17, docs/11 §6).
 * Called synchronously BEFORE each model call. If the projected total exceeds
 * the session budget → BUDGET_EXHAUSTED (the DO then transitions to failed).
 *
 * budgetLimitUsd null = no per-session cap (inherits team default — team-level
 * enforcement is the D1 quota store, §8.4 widening).
 */
export function checkBudget(opts: {
  currentTotalUsd: number;
  callCostUsd: number;
  budgetLimitUsd: number | null;
}): BudgetCheckResult {
  const projected = opts.currentTotalUsd + opts.callCostUsd;
  if (opts.budgetLimitUsd === null) {
    return { allowed: true, projectedTotalUsd: projected, budgetLimitUsd: null };
  }
  if (projected > opts.budgetLimitUsd) {
    return {
      allowed: false,
      reason: `budget exhausted: ${projected.toFixed(4)} > ${opts.budgetLimitUsd}`,
      projectedTotalUsd: projected,
      budgetLimitUsd: opts.budgetLimitUsd,
    };
  }
  return { allowed: true, projectedTotalUsd: projected, budgetLimitUsd: opts.budgetLimitUsd };
}

/** KV key for the platform-wide kill-switch (docs/12 §6). */
export const KILLSWITCH_KEY = "flag:killswitch";

/** Check the kill-switch value (docs/08 §17). on = pause all model calls. */
export function isKillSwitchOn(value: string | null | undefined): boolean {
  return value === "on";
}

/** The DO cost-counter read (the running total to check against). */
export interface CostCounter {
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
}

/** Sum cost entries into a counter (the DO applies this incrementally). */
export function tallyCosts(entries: ReadonlyArray<CostEntry>): CostCounter {
  let totalCostUsd = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  for (const e of entries) {
    totalCostUsd += e.costUsd;
    if (e.tokensIn !== null) totalTokensIn += e.tokensIn;
    if (e.tokensOut !== null) totalTokensOut += e.tokensOut;
  }
  return { totalCostUsd, totalTokensIn, totalTokensOut };
}
