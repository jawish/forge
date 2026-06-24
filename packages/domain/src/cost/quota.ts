// D1 quota store — per-team/user/session daily/weekly/monthly cost caps (docs/12 §3
// quota_counter table, docs/08 §17, §9 quotas + alerts). The session-level budget
// check is in budget.ts; this is the team/user-level aggregate enforcement.
//
// Pure logic; the D1 read/write is injected (testable). The period key is a date
// string ('2026-06-24'); the counter is cumulative within a period.

/** Quota scope (docs/12 §3). */
export type QuotaScope = "user" | "team" | "session";
/** Quota period (docs/12 §3). */
export type QuotaPeriod = "daily" | "weekly" | "monthly";

/** A quota limit for a scope+period. */
export interface QuotaLimit {
  scope: QuotaScope;
  scopeId: string;
  period: QuotaPeriod;
  /** The cost cap in USD (null = no cap at this level). */
  limitUsd: number | null;
}

/** A quota counter row (the D1 quota_counter table, docs/12 §3). */
export interface QuotaCounter {
  scope: QuotaScope;
  scopeId: string;
  period: QuotaPeriod;
  periodKey: string; // '2026-06-24' etc.
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

/** The result of a quota check. */
export interface QuotaCheckResult {
  allowed: boolean;
  /** Which limit was hit (if denied). */
  blockedBy?: { scope: QuotaScope; period: QuotaPeriod; limitUsd: number; currentUsd: number };
  /** The projected total after this call. */
  projectedUsd: number;
}

/** Compute the period key for a timestamp + period (docs/12 §3). */
export function periodKey(period: QuotaPeriod, ts: number, now = new Date(ts)): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  if (period === "daily") return `${yyyy}-${mm}-${dd}`;
  if (period === "monthly") return `${yyyy}-${mm}`;
  // weekly: ISO week (the Monday-anchored week number).
  const tmp = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (tmp.getUTCDay() + 6) % 7; // Mon=0
  tmp.setUTCDate(tmp.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((tmp.getTime() - firstThursday.getTime()) / 86_400_000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Port: read the current counter for a scope+period+key. */
export type ReadQuotaCounter = (
  scope: QuotaScope,
  scopeId: string,
  period: QuotaPeriod,
  periodKey: string,
) => Promise<QuotaCounter | null>;

/** Port: increment the counter (upsert). */
export type IncrementQuotaCounter = (
  scope: QuotaScope,
  scopeId: string,
  period: QuotaPeriod,
  periodKey: string,
  costUsd: number,
  tokensIn: number,
  tokensOut: number,
) => Promise<void>;

/**
 * Check all applicable quotas before a model call (docs/08 §17, §9).
 * Checks user + team limits for the current period; denies if any is exceeded.
 */
export async function checkQuotas(opts: {
  callCostUsd: number;
  tokensIn: number;
  tokensOut: number;
  userId: string;
  teamId: string;
  ts: number;
  limits: ReadonlyArray<QuotaLimit>;
  readCounter: ReadQuotaCounter;
}): Promise<QuotaCheckResult> {
  for (const limit of opts.limits) {
    if (limit.limitUsd === null) continue;
    const scopeId =
      limit.scope === "user" ? opts.userId : limit.scope === "team" ? opts.teamId : "";
    const key = periodKey(limit.period, opts.ts);
    const counter = await opts.readCounter(limit.scope, scopeId, limit.period, key);
    const current = counter?.costUsd ?? 0;
    const projected = current + opts.callCostUsd;
    if (projected > limit.limitUsd) {
      return {
        allowed: false,
        blockedBy: {
          scope: limit.scope,
          period: limit.period,
          limitUsd: limit.limitUsd,
          currentUsd: current,
        },
        projectedUsd: projected,
      };
    }
  }
  return { allowed: true, projectedUsd: opts.callCostUsd };
}

/** Apply a cost increment to all applicable quota counters (after a successful call). */
export async function applyQuotaIncrement(opts: {
  callCostUsd: number;
  tokensIn: number;
  tokensOut: number;
  userId: string;
  teamId: string;
  ts: number;
  scopes: ReadonlyArray<{ scope: QuotaScope; period: QuotaPeriod }>;
  increment: IncrementQuotaCounter;
}): Promise<void> {
  for (const { scope, period } of opts.scopes) {
    const scopeId = scope === "user" ? opts.userId : scope === "team" ? opts.teamId : "";
    const key = periodKey(period, opts.ts);
    await opts.increment(
      scope,
      scopeId,
      period,
      key,
      opts.callCostUsd,
      opts.tokensIn,
      opts.tokensOut,
    );
  }
}
