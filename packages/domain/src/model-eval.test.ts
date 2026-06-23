import { describe, expect, it } from "vitest";
import {
  evaluateTier,
  scoreCandidate,
  type EvalCandidate,
  type EvalCase,
  type EvalResult,
} from "./model-eval";

// Model eval framework (docs/08 §18, §7.3). Pure-logic tests for the scoring +
// ranking. The runSuite port is a deterministic fake.

const CASES: EvalCase[] = [
  { id: "c1", prompt: "fix the typo", expected: "tests green", weight: 1 },
  { id: "c2", prompt: "add a test", expected: "tests green", weight: 2 },
  { id: "c3", prompt: "refactor", expected: "diff matches intent", weight: 1 },
];

function results(
  modelId: string,
  passIds: string[],
  opts?: { cost?: number; quality?: number },
): EvalResult[] {
  return CASES.map((c) => ({
    caseId: c.id,
    passed: passIds.includes(c.id),
    costUsd: opts?.cost ?? 0.01,
    quality: opts?.quality ?? (passIds.includes(c.id) ? 1 : 0),
    durationMs: 1000,
  }));
}

describe("scoreCandidate (docs/08 §18)", () => {
  const candidate: EvalCandidate = { modelId: "m1", tier: "default" };

  it("computes the weighted pass rate + mean quality", () => {
    const score = scoreCandidate(candidate, results("m1", ["c1", "c2"]), CASES, 0.2);
    // 2/3 passed; c2 has weight 2 → weighted pass = (1*1 + 1*2 + 0*1) / (1+2+1) = 3/4.
    expect(score.passRate).toBeCloseTo(0.75, 2);
    expect(score.meanQuality).toBeCloseTo(0.75, 2);
  });

  it("a higher-cost candidate gets a lower composite (cost penalty)", () => {
    const cheap = scoreCandidate(
      candidate,
      results("m1", ["c1", "c2", "c3"], { cost: 0.01 }),
      CASES,
      0.3,
    );
    const expensive = scoreCandidate(
      candidate,
      results("m1", ["c1", "c2", "c3"], { cost: 0.1 }),
      CASES,
      0.3,
    );
    expect(cheap.composite).toBeGreaterThan(expensive.composite);
  });

  it("a fully-passing candidate scores higher than a partial one", () => {
    const full = scoreCandidate(candidate, results("m1", ["c1", "c2", "c3"]), CASES, 0.2);
    const partial = scoreCandidate(candidate, results("m1", ["c1"]), CASES, 0.2);
    expect(full.composite).toBeGreaterThan(partial.composite);
  });
});

describe("evaluateTier — ranks candidates + picks a winner (§7.3)", () => {
  it("ranks by composite + returns the winner", async () => {
    const r = await evaluateTier({
      tier: "default",
      cases: CASES,
      candidates: [
        { modelId: "good", tier: "default" },
        { modelId: "bad", tier: "default" },
      ],
      runSuite: async (modelId) =>
        modelId === "good"
          ? results(modelId, ["c1", "c2", "c3"], { cost: 0.01 })
          : results(modelId, ["c1"], { cost: 0.05 }),
    });
    expect(r.winner.modelId).toBe("good");
    expect(r.scores[0]!.modelId).toBe("good");
  });

  it("throws when no candidates match the tier", async () => {
    await expect(
      evaluateTier({
        tier: "classifier",
        cases: CASES,
        candidates: [{ modelId: "m", tier: "default" }],
        runSuite: async () => [],
      }),
    ).rejects.toThrow(/no candidates/);
  });
});
