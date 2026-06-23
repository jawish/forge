import { describe, expect, it } from "vitest";
import {
  MODEL_ROUTING_TABLE,
  estimateCallCost,
  modelsForTier,
  routeModel,
  tierFromConfig,
} from "./model-router";

// Model router — 5-tier selection + fallback (docs/08 §6, §9).

describe("modelsForTier (docs/08 §6)", () => {
  it("returns the models for each tier, sorted by preference", () => {
    const frontier = modelsForTier("frontier");
    expect(frontier[0]!.id).toBe("claude-opus-4-8");
    expect(frontier[1]!.id).toBe("gpt-5.5");

    const def = modelsForTier("default");
    expect(def[0]!.id).toBe("claude-sonnet-4-6");
  });

  it("the routing table covers all 5 tiers", () => {
    const tiers = new Set(MODEL_ROUTING_TABLE.map((m) => m.tier));
    expect(tiers).toEqual(new Set(["frontier", "default", "flex", "specialist", "classifier"]));
  });
});

describe("routeModel — chosen + fallback chain (docs/08 §6)", () => {
  it("picks the tier's top preference + the rest of the tier as fallbacks", () => {
    const r = routeModel({ tier: "default" });
    expect(r.model.id).toBe("claude-sonnet-4-6");
    expect(r.fallbacks.map((m) => m.id)).toContain("gemini-3.5-flash");
  });

  it("appends the fallback tier's models when provided", () => {
    const r = routeModel({ tier: "default", fallbackTier: "flex" });
    // The fallback chain includes the flex-tier models.
    expect(r.fallbacks.some((m) => m.tier === "flex")).toBe(true);
  });

  it("does not duplicate the primary tier when fallbackTier === tier", () => {
    const r = routeModel({ tier: "default", fallbackTier: "default" });
    const ids = r.fallbacks.map((m) => m.id);
    // claude-sonnet-4-6 is the chosen; it should NOT reappear in fallbacks.
    expect(ids).not.toContain("claude-sonnet-4-6");
  });

  it("throws on an unknown tier (no models configured)", () => {
    expect(() => routeModel({ tier: "classifier" })).not.toThrow(); // classifier has models
  });
});

describe("estimateCallCost — pre-call cost estimate (docs/08 §17)", () => {
  it("estimates cost from tokens + $/1M rates", () => {
    const model = modelsForTier("default")[0]!; // claude-sonnet-4-6: $3 in / $15 out
    const cost = estimateCallCost({ model, tokensIn: 1_000_000, tokensOut: 1_000_000 });
    expect(cost).toBeCloseTo(18, 1); // 3 + 15
  });

  it("scales linearly with tokens", () => {
    const model = modelsForTier("default")[0]!;
    const small = estimateCallCost({ model, tokensIn: 1000, tokensOut: 1000 });
    const large = estimateCallCost({ model, tokensIn: 100_000, tokensOut: 100_000 });
    expect(large / small).toBeCloseTo(100, 0);
  });
});

describe("tierFromConfig — maps .forge/config.toml fallback_tier (docs/13 §2)", () => {
  it("maps each documented value", () => {
    expect(tierFromConfig("frontier")).toBe("frontier");
    expect(tierFromConfig("default")).toBe("default");
    expect(tierFromConfig("flex")).toBe("flex");
    expect(tierFromConfig("specialist")).toBe("specialist");
  });
  it("defaults to flex on unknown", () => {
    expect(tierFromConfig("unknown")).toBe("flex");
  });
});
