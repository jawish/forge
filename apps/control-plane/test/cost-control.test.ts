/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { isKillSwitchOn, KILLSWITCH_KEY } from "@forge/domain";

// Cost control v1 (docs/08 §17, checklist §8.4). Seam test for the DO cost
// counters + synchronous pre-call budget check. Real DO (miniflare).

/** RPC stub for the cost-control DO methods. */
function session(id: string) {
  const idObj = env.SESSION_DO.idFromName(id);
  return env.SESSION_DO.get(idObj) as unknown as {
    spawn(i: {
      repoId: string;
      branch: string;
      createdByUserId: string;
      budgetLimitUsd?: number;
    }): Promise<{ sessionId: string }>;
    recordCost(e: {
      source: string;
      costUsd: number;
      tokensIn?: number | null;
      tokensOut?: number | null;
      model?: string | null;
    }): Promise<void>;
    checkBudgetBeforeCall(c: number): Promise<{
      allowed: boolean;
      reason?: string;
      projectedTotalUsd: number;
      budgetLimitUsd: number | null;
    }>;
    getStatus(): Promise<{ costUsd: number; tokensIn: number; tokensOut: number }>;
  };
}

describe("cost control — DO counters + pre-call budget check (§8.4)", () => {
  it("recordCost accumulates the running total on session_meta", async () => {
    const id = `cost_${Date.now()}`;
    const s = session(id);
    await s.spawn({ repoId: "r", branch: "b", createdByUserId: "u", budgetLimitUsd: 5 });
    await s.recordCost({ source: "model", costUsd: 0.5, tokensIn: 100, tokensOut: 50, model: "m" });
    await s.recordCost({
      source: "model",
      costUsd: 0.3,
      tokensIn: 200,
      tokensOut: 100,
      model: "m",
    });
    const status = await s.getStatus();
    expect(status.costUsd).toBeCloseTo(0.8, 5);
    expect(status.tokensIn).toBe(300);
    expect(status.tokensOut).toBe(150);
  });

  it("checkBudgetBeforeCall allows when under budget", async () => {
    const id = `cost_ok_${Date.now()}`;
    const s = session(id);
    await s.spawn({ repoId: "r", branch: "b", createdByUserId: "u", budgetLimitUsd: 5 });
    await s.recordCost({ source: "model", costUsd: 1, tokensIn: 1, tokensOut: 1 });
    const check = await s.checkBudgetBeforeCall(0.5);
    expect(check.allowed).toBe(true);
    expect(check.projectedTotalUsd).toBeCloseTo(1.5, 5);
    expect(check.budgetLimitUsd).toBe(5);
  });

  it("checkBudgetBeforeCall denies when the call would exceed budget", async () => {
    const id = `cost_over_${Date.now()}`;
    const s = session(id);
    await s.spawn({ repoId: "r", branch: "b", createdByUserId: "u", budgetLimitUsd: 1 });
    await s.recordCost({ source: "model", costUsd: 0.9, tokensIn: 1, tokensOut: 1 });
    const check = await s.checkBudgetBeforeCall(0.5);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("budget exhausted");
  });

  it("checkBudgetBeforeCall allows unlimited when budget null (inherit team default)", async () => {
    const id = `cost_unlim_${Date.now()}`;
    const s = session(id);
    await s.spawn({ repoId: "r", branch: "b", createdByUserId: "u" }); // no budget
    const check = await s.checkBudgetBeforeCall(1000);
    expect(check.allowed).toBe(true);
    expect(check.budgetLimitUsd).toBeNull();
  });

  it("the KV kill-switch value drives isKillSwitchOn (docs/12 §6)", async () => {
    // Set + read the kill-switch via the emulated KV binding.
    await env.CONFIG_KV.put(KILLSWITCH_KEY, "off");
    expect(isKillSwitchOn(await env.CONFIG_KV.get(KILLSWITCH_KEY))).toBe(false);
    await env.CONFIG_KV.put(KILLSWITCH_KEY, "on");
    expect(isKillSwitchOn(await env.CONFIG_KV.get(KILLSWITCH_KEY))).toBe(true);
  });
});
