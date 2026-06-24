// Phase 3: cross-repo orchestration, knowledge integration, self-improvement
// flywheel, in-platform review, eval harness (§10).
//
// These are the post-pilot widening features. Each is built as a pure-logic
// module with injected ports (testable without real infrastructure).

// --- Cross-repo orchestration (§10) ---

/** A cross-repo task that fans out to multiple repos in parallel. */
export interface CrossRepoTask {
  /** The orchestrating session (parent). */
  parentSessionId: string;
  /** The task description (e.g., "update all services to Node 22"). */
  task: string;
  /** The repos to apply the task to. */
  targets: Array<{ repoId: string; branch: string }>;
  /** Whether to run in parallel (true) or sequentially (false). */
  parallel: boolean;
}

/** The result of a cross-repo fan-out. */
export interface CrossRepoResult {
  /** One result per target repo. */
  results: Array<{
    repoId: string;
    status: "completed" | "failed" | "skipped";
    prUrl?: string;
    error?: string;
  }>;
  /** How many succeeded. */
  successCount: number;
}

/** Port: spawn a sub-session for a single repo (injected — the agent loop). */
export type RepoSessionSpawner = (input: {
  parentSessionId: string;
  repoId: string;
  branch: string;
  task: string;
}) => Promise<{
  sessionId: string;
  status: "completed" | "failed";
  prUrl?: string;
  error?: string;
}>;

/**
 * Orchestrate a cross-repo task: fan out to N repos in parallel or sequence
 * (docs/02 US-7.1, §10). Each repo gets its own sub-session; results are
 * collected into a summary.
 *
 * Pure orchestration — the spawn port is injected.
 */
export async function orchestrateCrossRepo(opts: {
  task: CrossRepoTask;
  spawn: RepoSessionSpawner;
}): Promise<CrossRepoResult> {
  const results: CrossRepoResult["results"] = [];

  if (opts.task.parallel) {
    // Parallel: spawn all at once, await all.
    const settled = await Promise.allSettled(
      opts.task.targets.map((t) =>
        opts.spawn({
          parentSessionId: opts.task.parentSessionId,
          repoId: t.repoId,
          branch: t.branch,
          task: opts.task.task,
        }),
      ),
    );
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      const target = opts.task.targets[i];
      if (!target) continue;
      if (result && result.status === "fulfilled") {
        results.push({ repoId: target.repoId, ...result.value });
      } else if (result && result.status === "rejected") {
        results.push({
          repoId: target.repoId,
          status: "failed",
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
  } else {
    // Sequential: spawn one at a time, stop on failure if desired.
    for (const target of opts.task.targets) {
      try {
        const r = await opts.spawn({
          parentSessionId: opts.task.parentSessionId,
          repoId: target.repoId,
          branch: target.branch,
          task: opts.task.task,
        });
        results.push({ repoId: target.repoId, ...r });
      } catch (err) {
        results.push({
          repoId: target.repoId,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    results,
    successCount: results.filter((r) => r.status === "completed").length,
  };
}

// --- Knowledge integration (§10) ---

/**
 * Knowledge integration: the platform learns from completed sessions and feeds
 * insights back into future sessions (docs/02 US-8.1, §10). The knowledge store
 * captures: what worked, what didn't, repo-specific patterns, common failures.
 *
 * Pure interface — the Vectorize/D1 implementation lives in the control plane.
 */
export interface KnowledgeStore {
  /** Record an insight from a completed session. */
  record(input: {
    repoId: string;
    insight: string;
    category: "pattern" | "failure" | "success" | "convention";
    sessionId: string;
  }): Promise<void>;
  /** Retrieve relevant insights for a repo + task (similarity search). */
  retrieve(input: {
    repoId: string;
    task: string;
    limit?: number;
  }): Promise<Array<{ insight: string; category: string; score: number }>>;
}

/** In-memory knowledge store (for tests + dev). */
export class MemoryKnowledgeStore implements KnowledgeStore {
  private entries: Array<{ repoId: string; insight: string; category: string; sessionId: string }> =
    [];
  async record(input: {
    repoId: string;
    insight: string;
    category: string;
    sessionId: string;
  }): Promise<void> {
    this.entries.push(input);
  }
  async retrieve(input: {
    repoId: string;
    task: string;
    limit?: number;
  }): Promise<Array<{ insight: string; category: string; score: number }>> {
    const limit = input.limit ?? 5;
    return this.entries
      .filter((e) => e.repoId === input.repoId)
      .slice(0, limit)
      .map((e) => ({ insight: e.insight, category: e.category, score: 1.0 }));
  }
}

// --- Self-improvement flywheel (§10) ---

/**
 * The self-improvement flywheel (docs/02 US-8.2, §10): completed sessions are
 * evaluated, insights are extracted, and the system prompts / MCP tools are
 * updated to incorporate the learnings. This is the feedback loop that makes
 * the platform improve over time.
 *
 * Pure orchestration — the model + knowledge ports are injected.
 */

/** A learning extracted from a completed session. */
export interface SessionLearning {
  sessionId: string;
  /** What the agent did well. */
  positives: string[];
  /** What the agent did poorly. */
  negatives: string[];
  /** Suggested prompt/tool improvements. */
  improvements: string[];
}

/** Port: analyze a completed session + extract learnings (injected — model call). */
export type SessionAnalyzer = (input: {
  sessionId: string;
  sessionLog: unknown;
}) => Promise<SessionLearning>;

/**
 * Run the self-improvement flywheel: analyze a session → extract learnings →
 * record insights in the knowledge store (docs/02 US-8.2, §10).
 */
export async function runSelfImprovement(opts: {
  sessionId: string;
  sessionLog: unknown;
  repoId: string;
  analyze: SessionAnalyzer;
  knowledge: KnowledgeStore;
}): Promise<SessionLearning> {
  const learning = await opts.analyze({
    sessionId: opts.sessionId,
    sessionLog: opts.sessionLog,
  });

  // Record each learning as a knowledge insight for the repo.
  for (const positive of learning.positives) {
    await opts.knowledge.record({
      repoId: opts.repoId,
      insight: positive,
      category: "success",
      sessionId: opts.sessionId,
    });
  }
  for (const negative of learning.negatives) {
    await opts.knowledge.record({
      repoId: opts.repoId,
      insight: negative,
      category: "failure",
      sessionId: opts.sessionId,
    });
  }
  for (const improvement of learning.improvements) {
    await opts.knowledge.record({
      repoId: opts.repoId,
      insight: improvement,
      category: "pattern",
      sessionId: opts.sessionId,
    });
  }

  return learning;
}

// --- In-platform review (§10) ---

/**
 * In-platform review (docs/02 US-6.1, §10): instead of reviewing on GitHub,
 * reviewers can review + approve PRs directly in the Forge web UI. The Review
 * Agent's structured comments are presented alongside the diff, and the reviewer
 * can add their own comments before approving/requesting changes.
 *
 * This is the review state model — the UI + real-time sync are built on top.
 */
export interface InPlatformReview {
  sessionId: string;
  /** The Review Agent's structured comments (from runReviewAgent). */
  agentComments: Array<{ category: string; severity: string; message: string }>;
  /** Human reviewer comments (added in the web UI). */
  humanComments: Array<{ author: string; message: string; ts: number }>;
  /** The review state. */
  state: "pending" | "approved" | "changes_requested";
}

/** Create a new in-platform review from a Review Agent result (§10). */
export function createInPlatformReview(opts: {
  sessionId: string;
  agentComments: Array<{ category: string; severity: string; message: string }>;
}): InPlatformReview {
  return {
    sessionId: opts.sessionId,
    agentComments: opts.agentComments,
    humanComments: [],
    state: "pending",
  };
}

/** Add a human comment to an in-platform review (§10). */
export function addHumanComment(
  review: InPlatformReview,
  comment: { author: string; message: string },
): InPlatformReview {
  return {
    ...review,
    humanComments: [...review.humanComments, { ...comment, ts: Date.now() }],
  };
}

/** Transition the review state (§10). */
export function transitionReviewState(
  review: InPlatformReview,
  newState: "approved" | "changes_requested",
): InPlatformReview {
  return { ...review, state: newState };
}
