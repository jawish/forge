// Context hygiene (docs/08 §6, RTK lesson, §9 Phase 2).
// Manages the conversation context window: trims old turns, summarizes when
// approaching the limit, and caps token usage per call. The RTK lesson was
// "unbounded context → degraded agent quality + cost blowup." This module is
// the guardrail.
//
// Pure logic; the tokenizer call is an injected port (testable without a real model).

/** A single conversation turn (message in the context window). */
export interface ContextTurn {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** Estimated token count (from the injected tokenizer). */
  tokenCount: number;
  /** When this turn was added (unix ms). */
  ts: number;
}

/** Context window config for a model tier (docs/08 §6). */
export interface ContextWindowConfig {
  /** The model's max context window (input tokens). */
  maxContextTokens: number;
  /** Reserve for the model's response (output tokens). */
  reserveOutputTokens: number;
  /** When the context exceeds this fraction of the window, trigger compaction. */
  compactionThreshold: number; // e.g., 0.8 = 80% full
  /** Minimum turns to always keep (never compact the most recent N turns). */
  minRecentTurns: number;
}

/** Default configs per tier (docs/08 §6). */
export const CONTEXT_WINDOW_DEFAULTS: Record<string, ContextWindowConfig> = {
  frontier: {
    maxContextTokens: 200_000,
    reserveOutputTokens: 8_000,
    compactionThreshold: 0.8,
    minRecentTurns: 4,
  },
  default: {
    maxContextTokens: 128_000,
    reserveOutputTokens: 4_000,
    compactionThreshold: 0.8,
    minRecentTurns: 4,
  },
  flex: {
    maxContextTokens: 32_000,
    reserveOutputTokens: 2_000,
    compactionThreshold: 0.85,
    minRecentTurns: 2,
  },
  specialist: {
    maxContextTokens: 128_000,
    reserveOutputTokens: 4_000,
    compactionThreshold: 0.8,
    minRecentTurns: 4,
  },
  classifier: {
    maxContextTokens: 8_000,
    reserveOutputTokens: 1_000,
    compactionThreshold: 0.9,
    minRecentTurns: 1,
  },
};

/** Port: summarize a set of turns into a compact summary (injected — testable). */
export type Summarizer = (turns: ContextTurn[]) => Promise<string>;
/** Port: count tokens for a string (injected — testable). */
export type TokenCounter = (text: string) => number;

/**
 * Check if the context window needs compaction (docs/08 §6).
 * Returns true when the total token count exceeds the compaction threshold.
 */
export function needsCompaction(turns: ContextTurn[], config: ContextWindowConfig): boolean {
  const totalTokens = turns.reduce((sum, t) => sum + t.tokenCount, 0);
  const budget =
    (config.maxContextTokens - config.reserveOutputTokens) * config.compactionThreshold;
  return totalTokens > budget;
}

/**
 * Compact the context window (docs/08 §6, RTK lesson): summarize old turns into
 * a single summary turn, keeping the most recent N turns intact. This keeps the
 * agent focused on recent context while retaining long-range information.
 *
 * Pure orchestration — the summarizer + token counter are injected ports.
 */
export async function compactContext(opts: {
  turns: ContextTurn[];
  config: ContextWindowConfig;
  summarize: Summarizer;
  countTokens: TokenCounter;
}): Promise<ContextTurn[]> {
  const { turns, config, summarize, countTokens } = opts;
  if (turns.length <= config.minRecentTurns) return turns;

  // Split: old turns (to summarize) + recent turns (to keep).
  const recent = turns.slice(-config.minRecentTurns);
  const old = turns.slice(0, turns.length - config.minRecentTurns);

  // Summarize the old turns into a single system message.
  const summaryText = await summarize(old);
  const summaryTurn: ContextTurn = {
    role: "system",
    content: `[context summary] ${summaryText}`,
    tokenCount: countTokens(summaryText),
    ts: old[old.length - 1]?.ts ?? Date.now(),
  };

  return [summaryTurn, ...recent];
}

/**
 * Full context hygiene pipeline: check if compaction is needed, compact if so.
 * Idempotent — if no compaction needed, returns the turns unchanged.
 */
export async function applyContextHygiene(opts: {
  turns: ContextTurn[];
  config: ContextWindowConfig;
  summarize: Summarizer;
  countTokens: TokenCounter;
}): Promise<ContextTurn[]> {
  if (!needsCompaction(opts.turns, opts.config)) return opts.turns;
  return compactContext(opts);
}
