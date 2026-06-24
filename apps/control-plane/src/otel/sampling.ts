// Session-scoped sampling + status-aware promotion (docs/14 §4).
// At session spawn, decide the sampling tier:
//   full (~20%, or 100% for high-sensitivity repos): emit all spans live.
//   skeleton (~80%): emit only skeleton spans; buffer the rest in DO SQLite.
// At terminal transition to failed/closed, PROMOTE skeleton → full: flush the
// buffered spans (failures are always captured — the flywheel's learning signal).
//
// Pure logic; the DO applies it (storing/flushing spans). ~3.6× span reduction
// at 100% failure capture (docs/14 §4 cost math).

import { isTerminalStatus, type SessionStatus } from "@forge/domain";

/** Sampling tiers (docs/14 §4). */
export type SamplingTier = "full" | "skeleton";

/** Decide the sampling tier at session spawn (docs/14 §4). */
export function decideSampling(opts: {
  /** Deterministic per-session (e.g. hash(sessionId) % 100). 0-99. */
  samplingRoll: number;
  /** High-sensitivity repo → 100% full. */
  highSensitivity?: boolean;
  /** Full-sampling rate (default 20 — docs/14 §4). */
  fullRatePercent?: number;
}): SamplingTier {
  if (opts.highSensitivity) return "full";
  const threshold = opts.fullRatePercent ?? 20; // ~20% full
  return opts.samplingRoll < threshold ? "full" : "skeleton";
}

/** Should a span be emitted live given the session's tier + the span's skeleton-ness? */
export function shouldEmitLive(opts: { tier: SamplingTier; isSkeletonSpan: boolean }): boolean {
  if (opts.tier === "full") return true;
  return opts.isSkeletonSpan; // skeleton tier: only skeleton spans emit live
}

/** The skeleton span set (docs/14 §4) — always emitted regardless of tier. */
export const SKELETON_SPANS: ReadonlySet<string> = new Set([
  "session.spawn",
  "session.transition",
  "session.cancel",
]);

/** Is a span a skeleton span (always live)? */
export function isSkeletonSpan(spanName: string): boolean {
  return SKELETON_SPANS.has(spanName);
}

/**
 * Status-aware promotion (docs/14 §4). At a terminal transition to failed/closed,
 * a skeleton session is promoted to full (the buffered spans flush). Returns the
 * new tier.
 */
export function promoteOnTerminal(
  currentTier: SamplingTier,
  toStatus: SessionStatus,
): SamplingTier {
  if (currentTier === "full") return "full";
  // Promote to full on failure-learning outcomes (docs/14 §4).
  if (toStatus === "failed" || toStatus === "closed") return "full";
  // Other terminal states (merged/no_change/cancelled) stay at their tier.
  return currentTier;
}

/** Whether promotion applies (terminal + was-skeleton). For the DO's flush trigger. */
export function shouldFlushOnTransition(opts: {
  currentTier: SamplingTier;
  toStatus: SessionStatus;
}): boolean {
  if (!isTerminalStatus(opts.toStatus)) return false;
  if (opts.currentTier === "full") return false; // already full — nothing buffered
  return opts.toStatus === "failed" || opts.toStatus === "closed";
}
