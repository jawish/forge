// Review Agent (docs/02 US-4.2, docs/11 §6, §9). A specialized agent that
// critiques a proposed diff before human review: security, perf, tests, edge cases.
// Posts structured comments; when review_agent_required is set, its verdict gates
// active → ready_for_pr (reviewAgentGate, §9 state module).
//
// Pure orchestration logic; the model calls are injected ports (testable).

import type { ReviewVerdict } from "./state";

/** A review critique category (docs/02 US-4.2). */
export type CritiqueCategory = "security" | "perf" | "tests" | "correctness" | "style";

/** Severity of a critique. */
export type CritiqueSeverity = "blocker" | "warning" | "nit" | "praise";

/** A single review comment from the Review Agent. */
export interface ReviewComment {
  category: CritiqueCategory;
  severity: CritiqueSeverity;
  /** The file + line range the comment targets (1-indexed). */
  location?: { file: string; startLine: number; endLine: number };
  message: string;
  /** An optional suggested fix. */
  suggestion?: string;
}

/** The Review Agent's verdict + comments on a proposed diff. */
export interface ReviewResult {
  verdict: ReviewVerdict;
  comments: ReviewComment[];
  /** The models that ran the critique (multi-model, docs/02 US-4.2). */
  models: string[];
  ts: number;
}

/** A diff to review (the agent's proposed changes). */
export interface ProposedDiff {
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
    patch: string; // unified diff
  }>;
  summary: string;
}

/** Port: run a single model's critique of the diff (injected — testable). */
export type CritiqueModel = (input: {
  diff: ProposedDiff;
  focusAreas?: CritiqueCategory[];
}) => Promise<ReviewComment[]>;

/**
 * Run the Review Agent: multi-model critique of a proposed diff (docs/02 US-4.2).
 * Each model reviews the diff; comments are merged + de-duplicated; the verdict is
 * derived from the worst severity (any blocker → request_changes).
 */
export async function runReviewAgent(opts: {
  diff: ProposedDiff;
  models: Array<{ id: string; critique: CritiqueModel }>;
  focusAreas?: CritiqueCategory[];
}): Promise<ReviewResult> {
  const allComments: ReviewComment[] = [];
  const modelIds: string[] = [];

  for (const model of opts.models) {
    modelIds.push(model.id);
    const comments = await model.critique({ diff: opts.diff, focusAreas: opts.focusAreas });
    for (const c of comments) {
      // De-duplicate: skip if an identical comment (same category+location+message) exists.
      const dup = allComments.some(
        (existing) =>
          existing.category === c.category &&
          existing.message === c.message &&
          existing.location?.file === c.location?.file &&
          existing.location?.startLine === c.location?.startLine,
      );
      if (!dup) allComments.push(c);
    }
  }

  // Sort by severity (blockers first), then category.
  const severityOrder: Record<CritiqueSeverity, number> = {
    blocker: 0,
    warning: 1,
    nit: 2,
    praise: 3,
  };
  allComments.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const verdict = deriveVerdict(allComments);

  return { verdict, comments: allComments, models: modelIds, ts: Date.now() };
}

/** Derive the verdict from the comments: any blocker → request_changes (docs/11 §6). */
export function deriveVerdict(comments: ReviewComment[]): ReviewVerdict {
  if (comments.some((c) => c.severity === "blocker")) return "request_changes";
  return "approve";
}

/** Summarize the review for the PR body / Slack thread (docs/02 US-4.2). */
export function summarizeReview(result: ReviewResult): string {
  const byCategory: Record<string, number> = {};
  for (const c of result.comments) {
    byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;
  }
  const lines: string[] = [
    `**Review Agent verdict: ${result.verdict}** (models: ${result.models.join(", ")})`,
    "",
  ];
  const blockerCount = result.comments.filter((c) => c.severity === "blocker").length;
  const warningCount = result.comments.filter((c) => c.severity === "warning").length;
  if (blockerCount > 0) lines.push(`🚫 ${blockerCount} blocker(s)`);
  if (warningCount > 0) lines.push(`⚠️ ${warningCount} warning(s)`);
  for (const [cat, count] of Object.entries(byCategory)) {
    lines.push(`- ${cat}: ${count}`);
  }
  if (result.comments.length === 0) lines.push("_No issues found._");
  return lines.join("\n");
}

// --- Testo: iterative test-fix loop (docs/02 US-4.2, §9) -------------------

/** The result of a Testo iteration loop. */
export interface TestoResult {
  /** The final review verdict after all iterations. */
  finalVerdict: ReviewVerdict;
  /** The number of fix iterations that ran. */
  iterations: number;
  /** The final review result (after the last iteration). */
  finalReview: ReviewResult;
  /** Whether the loop was capped by maxIterations without resolving blockers. */
  capped: boolean;
}

/**
 * Run the Testo iterative test-fix loop (docs/02 US-4.2, §9): review → if
 * blockers → give the agent a turn to fix → re-review → repeat until no
 * blockers or maxIterations reached.
 *
 * The "fix" port is the model's attempt to address the blockers (returns a new
 * diff). The "review" port is the Review Agent critique. Pure orchestration —
 * both ports are injected for testability.
 *
 * This is the Review Buddy behavior: the agent and the Review Agent take turns
 * until the diff is clean or the iteration budget is exhausted.
 */
export async function runTestoLoop(opts: {
  /** The initial proposed diff. */
  diff: ProposedDiff;
  /** The models running the review critique (passed to runReviewAgent). */
  reviewModels: Array<{ id: string; critique: CritiqueModel }>;
  /** Port: given a diff + blockers, return a new diff that addresses them. */
  fix: (input: { diff: ProposedDiff; blockers: ReviewComment[] }) => Promise<ProposedDiff>;
  /** Maximum fix iterations (default 3, docs/02 US-4.2). */
  maxIterations?: number;
  /** Focus areas for the review (passed to runReviewAgent). */
  focusAreas?: CritiqueCategory[];
}): Promise<TestoResult> {
  const maxIters = opts.maxIterations ?? 3;
  let currentDiff = opts.diff;
  let review = await runReviewAgent({
    diff: currentDiff,
    models: opts.reviewModels,
    focusAreas: opts.focusAreas,
  });
  let iterations = 0;

  // Loop: while there are blockers and we haven't hit the cap, fix + re-review.
  while (review.verdict === "request_changes" && iterations < maxIters) {
    const blockers = review.comments.filter((c) => c.severity === "blocker");
    currentDiff = await opts.fix({ diff: currentDiff, blockers });
    iterations++;
    review = await runReviewAgent({
      diff: currentDiff,
      models: opts.reviewModels,
      focusAreas: opts.focusAreas,
    });
  }

  return {
    finalVerdict: review.verdict,
    iterations,
    finalReview: review,
    capped: review.verdict === "request_changes" && iterations >= maxIters,
  };
}
