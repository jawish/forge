// Slack classifier (docs/19 Part A). Two-stage: intent filter → repo router,
// then a tiered-confidence policy decides the action (auto-spawn / confirm /
// disambiguate / explain). Pure logic; the model + Vectorize calls are injected
// ports so this is fully unit-testable without real AI/Vectorize bindings.

/** Stage-1 intent filter result (cheap tier-5 classifier, docs/19 §1). */
export interface IntentResult {
  isCodingTask: boolean;
  confidence: number; // 0-1
}

/** A repo candidate from stage-2 (Workers AI embeddings → Vectorize, docs/19 §1). */
export interface RepoCandidate {
  repoId: string;
  score: number; // 0-1 similarity
}

/** Stage-1 port: is this Slack text a coding-task request worth spawning for? */
export type IntentFilter = (input: {
  text: string;
  threadContext?: string;
}) => Promise<IntentResult>;

/** Stage-2 port: which repos does this text match? (embed → Vectorize top-K). */
export type RepoRouter = (input: { text: string }) => Promise<RepoCandidate[]>;

/** The decision the policy hands back to the handler (docs/19 §2). */
export type ClassifierDecision =
  | { tier: "reject"; reason: string } // stage-1 said not a coding task
  | { tier: "auto_spawn"; repoId: string }
  | { tier: "confirm"; repoId: string } // react ✅ to confirm
  | { tier: "disambiguate"; repoIds: string[] } // top 3 candidates
  | { tier: "explain" }; // couldn't figure out the repo

// --- Tier thresholds (docs/19 §2). Tunable; these are the doc's defaults. ---
const HIGH_SCORE = 0.8;
const HIGH_MARGIN = 0.2;
const MEDIUM_SCORE = 0.5;
const LOW_SCORE = 0.3;
const MAX_DISAMBIGUATE = 3;
/** 3+ repos within this margin of the top → tie → disambiguate. */
const TIE_MARGIN = 0.15;

/**
 * Run the two-stage classifier + tiered-confidence policy (docs/19 Part A).
 *
 * 1. Intent filter: if not a coding task (or low confidence) → reject.
 * 2. Repo router: embed → Vectorize → ranked candidates.
 * 3. Policy: map the candidate scores to an action tier.
 *
 * The ports (intentFilter, repoRouter) are injected — real impls use Workers AI
 * + Vectorize (§6/prod); tests inject deterministic fakes (docs/16 §1 mocking).
 */
export async function classify(
  input: { text: string; threadContext?: string },
  ports: { intentFilter: IntentFilter; repoRouter: RepoRouter },
): Promise<{ intent: IntentResult; candidates: RepoCandidate[]; decision: ClassifierDecision }> {
  // Stage 1: intent filter (cheap model).
  const intent = await ports.intentFilter(input);
  if (!intent.isCodingTask || intent.confidence < 0.5) {
    return {
      intent,
      candidates: [],
      decision: {
        tier: "reject",
        reason: "not a coding task (low intent confidence)",
      },
    };
  }

  // Stage 2: repo router (embed → Vectorize top-K).
  const candidates = await ports.repoRouter({ text: input.text });

  // Policy: tiered confidence (docs/19 §2). Never silently pick a low-confidence guess.
  const decision = applyPolicy(candidates);
  return { intent, candidates, decision };
}

/** Map ranked candidates to an action tier (docs/19 §2). Pure — no I/O. */
export function applyPolicy(candidates: RepoCandidate[]): ClassifierDecision {
  if (candidates.length === 0) return { tier: "explain" };

  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const top = sorted[0]!;
  const second = sorted[1];
  const margin = second ? top.score - second.score : 1;

  // No match: all scores below threshold.
  if (top.score < LOW_SCORE) return { tier: "explain" };

  // Low / tie: 3+ repos within TIE_MARGIN of the top, or top below MEDIUM.
  const withinTie = sorted.filter((c) => top.score - c.score <= TIE_MARGIN);
  if (top.score < MEDIUM_SCORE || withinTie.length >= MAX_DISAMBIGUATE) {
    return {
      tier: "disambiguate",
      repoIds: sorted.slice(0, MAX_DISAMBIGUATE).map((c) => c.repoId),
    };
  }

  // High: top score > 0.8 AND margin > 0.2.
  if (top.score > HIGH_SCORE && margin > HIGH_MARGIN) {
    return { tier: "auto_spawn", repoId: top.repoId };
  }

  // Medium: top 0.5–0.8 OR margin < 0.2 → confirm.
  return { tier: "confirm", repoId: top.repoId };
}

/**
 * The dedup key: a session is already running for the same (repo, branch,
 * slack_thread) tuple → don't spawn a duplicate (docs/19 §4).
 */
export function dedupKey(repoId: string, branch: string, slackThread: string): string {
  return `${repoId}|${branch}|${slackThread}`;
}
