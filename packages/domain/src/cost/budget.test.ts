import { describe, expect, it } from "vitest";
import { checkBudget, isKillSwitchOn, KILLSWITCH_KEY, tallyCosts, type CostEntry } from "./budget";

// Cost control v1 (docs/08 §17, docs/11 §6). Pure-logic unit tests for the
// pre-call budget check, KV kill-switch, and cost tallying.

describe("checkBudget — synchronous pre-call budget check (docs/08 §17)", () => {
  it("allows when projected total is under the budget", () => {
    const r = checkBudget({ currentTotalUsd: 1.0, callCostUsd: 0.5, budgetLimitUsd: 5.0 });
    expect(r.allowed).toBe(true);
    expect(r.projectedTotalUsd).toBe(1.5);
  });

  it("allows exactly at the budget boundary", () => {
    const r = checkBudget({ currentTotalUsd: 4.5, callCostUsd: 0.5, budgetLimitUsd: 5.0 });
    expect(r.allowed).toBe(true);
  });

  it("denies when projected total exceeds the budget", () => {
    const r = checkBudget({ currentTotalUsd: 4.8, callCostUsd: 0.5, budgetLimitUsd: 5.0 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("budget exhausted");
    expect(r.projectedTotalUsd).toBe(5.3);
  });

  it("allows unlimited when budget is null (inherit team default)", () => {
    const r = checkBudget({ currentTotalUsd: 1000, callCostUsd: 100, budgetLimitUsd: null });
    expect(r.allowed).toBe(true);
    expect(r.budgetLimitUsd).toBeNull();
  });

  it("denies a call that alone exceeds the budget", () => {
    const r = checkBudget({ currentTotalUsd: 0, callCostUsd: 10, budgetLimitUsd: 5 });
    expect(r.allowed).toBe(false);
  });
});

describe("kill-switch (docs/08 §17, docs/12 §6)", () => {
  it("isKillSwitchOn is true only for 'on'", () => {
    expect(isKillSwitchOn("on")).toBe(true);
    expect(isKillSwitchOn("off")).toBe(false);
    expect(isKillSwitchOn(null)).toBe(false);
    expect(isKillSwitchOn(undefined)).toBe(false);
  });
  it("KILLSWITCH_KEY is the documented KV key", () => {
    expect(KILLSWITCH_KEY).toBe("flag:killswitch");
  });
});

describe("tallyCosts — incremental counter (docs/08 §17)", () => {
  it("sums cost + tokens across entries", () => {
    const entries: CostEntry[] = [
      {
        ts: 1,
        source: "model",
        costUsd: 0.01,
        tokensIn: 100,
        tokensOut: 50,
        model: "m",
        detailJson: null,
      },
      {
        ts: 2,
        source: "model",
        costUsd: 0.02,
        tokensIn: 200,
        tokensOut: 100,
        model: "m",
        detailJson: null,
      },
      {
        ts: 3,
        source: "sandbox_cpu",
        costUsd: 0.001,
        tokensIn: null,
        tokensOut: null,
        model: null,
        detailJson: null,
      },
    ];
    const counter = tallyCosts(entries);
    expect(counter.totalCostUsd).toBeCloseTo(0.031, 5);
    expect(counter.totalTokensIn).toBe(300);
    expect(counter.totalTokensOut).toBe(150);
  });

  it("returns zeros for an empty set", () => {
    const counter = tallyCosts([]);
    expect(counter.totalCostUsd).toBe(0);
    expect(counter.totalTokensIn).toBe(0);
    expect(counter.totalTokensOut).toBe(0);
  });
});
