import { describe, expect, it } from "vitest";
import { applyPolicy, classify, dedupKey } from "./classifier";
import type { IntentFilter, RepoCandidate, RepoRouter } from "./classifier";

// Slack classifier policy (docs/19 Part A §2). Pure-logic unit tests for the
// tiered-confidence tiers: auto-spawn / confirm / disambiguate / explain / reject.
// The intentFilter + repoRouter ports are deterministic fakes.

const C = (repoId: string, score: number): RepoCandidate => ({ repoId, score });

describe("applyPolicy — tiered confidence (docs/19 §2)", () => {
  it("auto_spawn: top score > 0.8 AND margin > 0.2", () => {
    expect(applyPolicy([C("monolith", 0.95), C("other", 0.5)])).toEqual({
      tier: "auto_spawn",
      repoId: "monolith",
    });
  });

  it("auto_spawn with a single high-confidence candidate (margin = 1)", () => {
    expect(applyPolicy([C("monolith", 0.9)])).toEqual({
      tier: "auto_spawn",
      repoId: "monolith",
    });
  });

  it("confirm: top 0.5–0.8 with a clear margin", () => {
    expect(applyPolicy([C("monolith", 0.65), C("other", 0.2)])).toEqual({
      tier: "confirm",
      repoId: "monolith",
    });
  });

  it("confirm: high top but margin < 0.2 (ambiguous between top two)", () => {
    expect(applyPolicy([C("a", 0.85), C("b", 0.7)])).toEqual({
      tier: "confirm",
      repoId: "a",
    });
  });

  it("disambiguate: 3+ repos within the tie margin", () => {
    const decision = applyPolicy([C("a", 0.7), C("b", 0.68), C("c", 0.66), C("d", 0.4)]);
    expect(decision.tier).toBe("disambiguate");
    if (decision.tier === "disambiguate") {
      expect(decision.repoIds).toEqual(["a", "b", "c"]);
    }
  });

  it("disambiguate: top below 0.5 (low confidence)", () => {
    const decision = applyPolicy([C("a", 0.45), C("b", 0.3)]);
    expect(decision.tier).toBe("disambiguate");
  });

  it("explain: all scores below 0.3", () => {
    expect(applyPolicy([C("a", 0.2), C("b", 0.1)])).toEqual({ tier: "explain" });
  });

  it("explain: no candidates", () => {
    expect(applyPolicy([])).toEqual({ tier: "explain" });
  });

  it("candidates are sorted by score before tiering", () => {
    // Unsorted input → still picks the highest.
    const decision = applyPolicy([C("low", 0.5), C("high", 0.9), C("mid", 0.6)]);
    expect(decision).toEqual({ tier: "auto_spawn", repoId: "high" });
  });
});

describe("classify — two-stage with injected ports", () => {
  const alwaysCoding: IntentFilter = async () => ({ isCodingTask: true, confidence: 0.9 });
  const notCoding: IntentFilter = async () => ({ isCodingTask: false, confidence: 0.2 });
  const lowConfidence: IntentFilter = async () => ({ isCodingTask: true, confidence: 0.3 });

  it("rejects when stage-1 says not a coding task", async () => {
    const { decision } = await classify(
      { text: "thanks @forge" },
      { intentFilter: notCoding, repoRouter: async () => [] },
    );
    expect(decision.tier).toBe("reject");
  });

  it("rejects when stage-1 confidence < 0.5", async () => {
    const { decision } = await classify(
      { text: "fix the bug" },
      { intentFilter: lowConfidence, repoRouter: async () => [C("r", 0.9)] },
    );
    expect(decision.tier).toBe("reject");
  });

  it("auto-spawns when intent passes + repo router is confident", async () => {
    const router: RepoRouter = async () => [C("monolith", 0.95)];
    const { decision } = await classify(
      { text: "fix the bug in monolith" },
      { intentFilter: alwaysCoding, repoRouter: router },
    );
    expect(decision).toEqual({ tier: "auto_spawn", repoId: "monolith" });
  });

  it("explains when the router finds no confident match", async () => {
    const router: RepoRouter = async () => [C("x", 0.2)];
    const { decision } = await classify(
      { text: "do something" },
      { intentFilter: alwaysCoding, repoRouter: router },
    );
    expect(decision.tier).toBe("explain");
  });
});

describe("dedupKey", () => {
  it("builds the (repo, branch, slack_thread) tuple key (docs/19 §4)", () => {
    expect(dedupKey("monolith", "main", "C123:T456")).toBe("monolith|main|C123:T456");
  });
  it("different threads produce different keys", () => {
    expect(dedupKey("r", "main", "C1:T1")).not.toBe(dedupKey("r", "main", "C1:T2"));
  });
});
