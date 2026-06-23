import { describe, expect, it } from "vitest";
import {
  applyQuotaIncrement,
  checkQuotas,
  periodKey,
  type QuotaCounter,
  type QuotaLimit,
} from "./quota";

// D1 quota store (docs/12 §3, docs/08 §17, §9). Pure-logic tests for period keys,
// the team/user quota check, and the increment application.

const TS = Date.UTC(2026, 5, 24, 13, 0); // 2026-06-24 13:00 UTC

describe("periodKey (docs/12 §3)", () => {
  it("daily key is yyyy-mm-dd", () => {
    expect(periodKey("daily", TS)).toBe("2026-06-24");
  });
  it("monthly key is yyyy-mm", () => {
    expect(periodKey("monthly", TS)).toBe("2026-06");
  });
  it("weekly key is an ISO week (yyyy-Www)", () => {
    expect(periodKey("weekly", TS)).toMatch(/^2026-W\d{2}$/);
    // 2026-06-24 is a Wednesday in ISO week 26.
    expect(periodKey("weekly", TS)).toBe("2026-W26");
  });
});

describe("checkQuotas (docs/08 §17, §9)", () => {
  const limits: QuotaLimit[] = [
    { scope: "user", scopeId: "user_1", period: "daily", limitUsd: 10 },
    { scope: "team", scopeId: "team_1", period: "weekly", limitUsd: 50 },
  ];

  function fakeReader(current: Record<string, number>) {
    return async (
      scope: string,
      scopeId: string,
      period: string,
      key: string,
    ): Promise<QuotaCounter | null> => {
      const k = `${scope}|${scopeId}|${period}|${key}`;
      const cost = current[k] ?? 0;
      if (cost === 0) return null;
      return {
        scope: scope as QuotaCounter["scope"],
        scopeId,
        period: period as QuotaCounter["period"],
        periodKey: key,
        costUsd: cost,
        tokensIn: 0,
        tokensOut: 0,
      };
    };
  }

  it("allows when all limits are under the cap", async () => {
    const r = await checkQuotas({
      callCostUsd: 1,
      tokensIn: 100,
      tokensOut: 50,
      userId: "user_1",
      teamId: "team_1",
      ts: TS,
      limits,
      readCounter: fakeReader({}),
    });
    expect(r.allowed).toBe(true);
  });

  it("denies when the user daily limit is exceeded", async () => {
    const dailyKey = periodKey("daily", TS);
    const r = await checkQuotas({
      callCostUsd: 2,
      tokensIn: 100,
      tokensOut: 50,
      userId: "user_1",
      teamId: "team_1",
      ts: TS,
      limits,
      readCounter: fakeReader({ [`user|user_1|daily|${dailyKey}`]: 9.5 }),
    });
    expect(r.allowed).toBe(false);
    expect(r.blockedBy?.scope).toBe("user");
    expect(r.blockedBy?.period).toBe("daily");
    expect(r.blockedBy?.limitUsd).toBe(10);
  });

  it("denies when the team weekly limit is exceeded", async () => {
    const weeklyKey = periodKey("weekly", TS);
    const r = await checkQuotas({
      callCostUsd: 5,
      tokensIn: 100,
      tokensOut: 50,
      userId: "user_1",
      teamId: "team_1",
      ts: TS,
      limits,
      readCounter: fakeReader({ [`team|team_1|weekly|${weeklyKey}`]: 48 }),
    });
    expect(r.allowed).toBe(false);
    expect(r.blockedBy?.scope).toBe("team");
  });

  it("skips null limits (no cap at that level)", async () => {
    const r = await checkQuotas({
      callCostUsd: 1_000_000,
      tokensIn: 0,
      tokensOut: 0,
      userId: "u",
      teamId: "t",
      ts: TS,
      limits: [{ scope: "team", scopeId: "t", period: "monthly", limitUsd: null }],
      readCounter: fakeReader({}),
    });
    expect(r.allowed).toBe(true);
  });
});

describe("applyQuotaIncrement (docs/12 §3)", () => {
  it("increments all configured scope+period counters", async () => {
    const incremented: string[] = [];
    await applyQuotaIncrement({
      callCostUsd: 0.5,
      tokensIn: 100,
      tokensOut: 50,
      userId: "u1",
      teamId: "t1",
      ts: TS,
      scopes: [
        { scope: "user", period: "daily" },
        { scope: "team", period: "weekly" },
      ],
      increment: async (scope, scopeId, period, key) => {
        incremented.push(`${scope}|${scopeId}|${period}|${key}`);
      },
    });
    expect(incremented).toHaveLength(2);
    expect(incremented[0]).toContain("user|u1|daily|2026-06-24");
    expect(incremented[1]).toContain("team|t1|weekly|2026-W26");
  });
});
