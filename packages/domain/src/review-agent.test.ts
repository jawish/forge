import { describe, expect, it } from "vitest";
import {
  deriveVerdict,
  runReviewAgent,
  summarizeReview,
  runTestoLoop,
  type CritiqueModel,
  type ProposedDiff,
  type ReviewComment,
} from "./review-agent";

// Review Agent (docs/02 US-4.2, docs/11 §6, §9). Pure-logic tests for the
// multi-model critique, verdict derivation, de-dup, + summary.

const DIFF: ProposedDiff = {
  files: [{ path: "src/checkout.ts", additions: 10, deletions: 2, patch: "@@ ... @@" }],
  summary: "Fix the checkout total bug",
};

function comment(c: Partial<ReviewComment>): ReviewComment {
  return {
    category: c.category ?? "correctness",
    severity: c.severity ?? "warning",
    message: c.message ?? "issue",
    location: c.location,
    suggestion: c.suggestion,
  };
}

function model(id: string, comments: ReviewComment[]): { id: string; critique: CritiqueModel } {
  return { id, critique: async () => comments };
}

describe("runReviewAgent — multi-model critique (docs/02 US-4.2)", () => {
  it("merges comments from multiple models", async () => {
    const r = await runReviewAgent({
      diff: DIFF,
      models: [
        model("claude-sonnet-4-6", [comment({ category: "security", message: "IDOR risk" })]),
        model("gpt-5.5", [comment({ category: "perf", message: "N+1 query" })]),
      ],
    });
    expect(r.comments).toHaveLength(2);
    expect(r.models).toEqual(["claude-sonnet-4-6", "gpt-5.5"]);
  });

  it("de-duplicates identical comments across models", async () => {
    const dup = comment({
      category: "security",
      message: "SQL injection",
      location: { file: "a.ts", startLine: 1, endLine: 1 },
    });
    const r = await runReviewAgent({
      diff: DIFF,
      models: [model("m1", [dup]), model("m2", [dup])],
    });
    expect(r.comments).toHaveLength(1);
  });

  it("sorts blockers first", async () => {
    const r = await runReviewAgent({
      diff: DIFF,
      models: [
        model("m", [
          comment({ severity: "nit", message: "naming" }),
          comment({ severity: "blocker", message: "critical" }),
          comment({ severity: "warning", message: "minor" }),
        ]),
      ],
    });
    expect(r.comments[0]!.severity).toBe("blocker");
    expect(r.comments[1]!.severity).toBe("warning");
  });
});

describe("deriveVerdict — gates active → ready_for_pr (docs/11 §6)", () => {
  it("any blocker → request_changes", () => {
    expect(deriveVerdict([comment({ severity: "blocker" })])).toBe("request_changes");
  });
  it("no blockers → approve", () => {
    expect(deriveVerdict([comment({ severity: "warning" }), comment({ severity: "nit" })])).toBe(
      "approve",
    );
  });
  it("empty → approve", () => {
    expect(deriveVerdict([])).toBe("approve");
  });
});

describe("summarizeReview — PR body / Slack summary (docs/02 US-4.2)", () => {
  it("includes the verdict + counts + model list", () => {
    const summary = summarizeReview({
      verdict: "request_changes",
      models: ["claude-sonnet-4-6", "gpt-5.5"],
      comments: [
        comment({ severity: "blocker", category: "security" }),
        comment({ severity: "warning", category: "perf" }),
      ],
      ts: 0,
    });
    expect(summary).toContain("request_changes");
    expect(summary).toContain("claude-sonnet-4-6");
    expect(summary).toContain("1 blocker");
    expect(summary).toContain("security: 1");
  });

  it("notes no issues when clean", () => {
    const summary = summarizeReview({
      verdict: "approve",
      models: ["m"],
      comments: [],
      ts: 0,
    });
    expect(summary).toContain("No issues found");
  });
});

// --- Testo loop tests (§9) ---

describe("runTestoLoop — iterative test-fix loop (§9)", () => {
  it("approves immediately when no blockers", async () => {
    const result = await runTestoLoop({
      diff: { files: [], summary: "clean" },
      reviewModels: [
        {
          id: "reviewer",
          critique: async () => [{ severity: "praise", category: "style", message: "great" }],
        },
      ],
      fix: async ({ diff }) => diff,
      maxIterations: 3,
    });
    expect(result.finalVerdict).toBe("approve");
    expect(result.iterations).toBe(0);
    expect(result.capped).toBe(false);
  });

  it("iterates: blocker → fix → approve", async () => {
    let callCount = 0;
    const result = await runTestoLoop({
      diff: { files: [], summary: "has a bug" },
      reviewModels: [
        {
          id: "reviewer",
          critique: async () => {
            callCount++;
            return callCount === 1
              ? [{ severity: "blocker", category: "security", message: "SQL injection" }]
              : [];
          },
        },
      ],
      fix: async ({ diff }) => ({ ...diff, summary: "fixed" }),
      maxIterations: 3,
    });
    expect(result.finalVerdict).toBe("approve");
    expect(result.iterations).toBe(1);
    expect(result.capped).toBe(false);
  });

  it("caps at maxIterations when blockers persist", async () => {
    const result = await runTestoLoop({
      diff: { files: [], summary: "stubborn bug" },
      reviewModels: [
        {
          id: "reviewer",
          critique: async () => [
            { severity: "blocker", category: "security", message: "still vulnerable" },
          ],
        },
      ],
      fix: async ({ diff }) => diff,
      maxIterations: 2,
    });
    expect(result.finalVerdict).toBe("request_changes");
    expect(result.iterations).toBe(2);
    expect(result.capped).toBe(true);
  });
});
