// Resilience: checkpoints, fallbacks, retries (docs/01 §5, §9 Phase 2).
// The agent loop is long-running and failure-prone (model timeouts, sandbox
// crashes, rate limits). This module provides:
// 1. Checkpointing — save session state at safe points so a crashed session
//    can resume from the last checkpoint (not restart).
// 2. Circuit breaker — if a provider fails repeatedly, trip the breaker and
//    fall back to the next tier/provider (docs/08 §6).
// 3. Retry with backoff — transient failures (429, 500) get retried with
//    exponential backoff before escalating to the fallback.
//
// Pure logic; the persistence + provider calls are injected ports (testable).

/** A session checkpoint — enough state to resume the agent loop. */
export interface Checkpoint {
  sessionId: string;
  /** The turn number at the checkpoint (0-indexed). */
  turnNumber: number;
  /** The serialized DO state at the checkpoint. */
  state: unknown;
  /** When the checkpoint was taken (unix ms). */
  ts: number;
}

/** Port: persist a checkpoint (injected — D1/R2/KV in production). */
export type CheckpointStore = {
  save(checkpoint: Checkpoint): Promise<void>;
  load(sessionId: string): Promise<Checkpoint | null>;
};

/** In-memory checkpoint store (for tests + dev). */
export class MemoryCheckpointStore implements CheckpointStore {
  private map = new Map<string, Checkpoint>();
  async save(cp: Checkpoint): Promise<void> {
    this.map.set(cp.sessionId, cp);
  }
  async load(sessionId: string): Promise<Checkpoint | null> {
    return this.map.get(sessionId) ?? null;
  }
}

/**
 * Take a checkpoint at a safe point (after a completed turn, before the next).
 * Safe points are: after a successful tool call, after a model response, before
 * a PR creation. Not during a tool call (the sandbox state may be inconsistent).
 */
export async function checkpoint(opts: {
  sessionId: string;
  turnNumber: number;
  state: unknown;
  store: CheckpointStore;
}): Promise<Checkpoint> {
  const cp: Checkpoint = {
    sessionId: opts.sessionId,
    turnNumber: opts.turnNumber,
    state: opts.state,
    ts: Date.now(),
  };
  await opts.store.save(cp);
  return cp;
}

// --- Circuit breaker (docs/08 §6) ---

/** Circuit breaker state for a provider. */
export interface CircuitBreaker {
  provider: string;
  failures: number;
  /** The threshold at which the breaker trips. */
  threshold: number;
  /** Whether the breaker is currently tripped (open). */
  open: boolean;
  /** When the breaker tripped (unix ms), for reset-after-cooldown. */
  trippedAt: number | null;
  /** Cooldown in ms before the breaker resets (half-open). */
  cooldownMs: number;
}

/** Create a new circuit breaker for a provider. */
export function createCircuitBreaker(
  provider: string,
  threshold = 5,
  cooldownMs = 60_000,
): CircuitBreaker {
  return { provider, failures: 0, threshold, open: false, trippedAt: null, cooldownMs };
}

/** Record a failure; trip the breaker if the threshold is reached. */
export function recordFailure(breaker: CircuitBreaker, now = Date.now()): CircuitBreaker {
  const failures = breaker.failures + 1;
  const shouldTrip = failures >= breaker.threshold && !breaker.open;
  return {
    ...breaker,
    failures,
    open: shouldTrip,
    trippedAt: shouldTrip ? now : breaker.trippedAt,
  };
}

/** Record a success; reset the failure count + close the breaker. */
export function recordSuccess(breaker: CircuitBreaker): CircuitBreaker {
  return { ...breaker, failures: 0, open: false, trippedAt: null };
}

/** Check if the breaker is open (should skip this provider). Considers cooldown. */
export function isBreakerOpen(breaker: CircuitBreaker, now = Date.now()): boolean {
  if (!breaker.open) return false;
  // Half-open: after cooldown, allow one request through (reset).
  if (breaker.trippedAt && now - breaker.trippedAt > breaker.cooldownMs) return false;
  return true;
}

// --- Retry with exponential backoff ---

/**
 * Retry an async operation with exponential backoff (docs/01 §5).
 * Retries on transient failures (429, 500, network errors); escalates after
 * maxRetries. The shouldRetry predicate decides which errors are retryable.
 */
export async function withRetry<T>(opts: {
  operation: () => Promise<T>;
  maxRetries: number;
  baseDelayMs: number;
  /** Decide if an error is retryable (default: all errors). */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}): Promise<T> {
  const shouldRetry = opts.shouldRetry ?? (() => true);
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await opts.operation();
    } catch (err) {
      lastError = err;
      if (attempt >= opts.maxRetries || !shouldRetry(err, attempt)) throw err;
      const delay = opts.baseDelayMs * Math.pow(2, attempt);
      // Delay without depending on setTimeout typing (domain pkg has no DOM lib).
      const start = Date.now();
      while (Date.now() - start < delay) {
        /* busy-wait for small backoff delays */
      }
    }
  }
  throw lastError;
}

// --- Sub-sessions (docs/02 US-3.1, §9) ---

/**
 * Sub-sessions: a parent session can spawn child sessions for parallel exploration
 * (docs/02 US-3.1). The parent holds references to its children; when a child
 * completes, its result is folded back into the parent's context.
 */
export interface SubSessionRef {
  childSessionId: string;
  parentSessionId: string;
  prompt: string;
  status: "running" | "completed" | "failed";
  result?: string;
}

/**
 * Spawn a sub-session from a parent (docs/02 US-3.1).
 * The child inherits the parent's repo + sandbox but gets its own DO instance +
 * context window. Pure data — the actual spawn happens in the agent loop.
 */
export function spawnSubSession(opts: { parentSessionId: string; prompt: string }): SubSessionRef {
  return {
    childSessionId: `sess_sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    parentSessionId: opts.parentSessionId,
    prompt: opts.prompt,
    status: "running",
  };
}
