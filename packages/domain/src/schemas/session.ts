// Zod schemas for session entities — the tRPC/MCP input validators (docs/10 §2).
// Mirror the plain types in types/session.ts. Where a schema is the source for
// an input contract, it's exported with a clear name (e.g. sessionCreateInputSchema).

import { z } from "zod";
import {
  nullableActivitySchema,
  sessionOutcomeSchema,
  sessionStatusSchema,
  terminalStatusSchema,
} from "./state";

// --- Enums shared with types -------------------------------------------------

export const promptTypeSchema = z.enum(["user", "agent_internal", "system"]);
export const toolCallStatusSchema = z.enum(["success", "error", "timeout", "cancelled"]);
export const artifactTypeSchema = z.enum([
  "diff",
  "test_result",
  "screenshot",
  "telemetry",
  "report",
  "review_critique",
]);
export const artifactGeneratedBySchema = z.enum(["agent", "user", "review_agent"]);
export const costSourceSchema = z.enum([
  "model",
  "sandbox_cpu",
  "sandbox_egress",
  "browser_run",
  "other",
]);

// --- Model params (per-prompt/turn snapshot) --------------------------------

export const modelParamsSchema = z.object({
  model: z.string().min(1),
  reasoning: z.string().optional(),
  temperature: z.number().optional(),
});

// --- Session entity (full row, DO SQLite + D1 projection) -------------------

export const sessionSchema = z.object({
  id: z.string().min(1),
  repoId: z.string().min(1),
  branch: z.string().min(1),
  createdByUserId: z.string().min(1),
  parentSessionId: z.string().nullable(),
  rootSessionId: z.string().min(1),
  status: sessionStatusSchema,
  activity: nullableActivitySchema,
  primaryModel: z.string().nullable(),
  sandboxImageVersion: z.string().nullable(),
  sandboxId: z.string().nullable(),
  prUrl: z.string().nullable(),
  prNumber: z.number().int().nullable(),
  createdAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nullable(),
  mergedAt: z.number().int().nullable(),
  totalCostUsd: z.number().nonnegative(),
  totalTokensIn: z.number().int().nonnegative(),
  totalTokensOut: z.number().int().nonnegative(),
  budgetLimitUsd: z.number().nonnegative().nullable(),
  outcome: sessionOutcomeSchema.nullable(),
  failureReason: z.string().nullable(),
});

// --- Status history ---------------------------------------------------------

export const statusHistoryEntrySchema = z.object({
  id: z.number().int().optional(),
  fromStatus: sessionStatusSchema.nullable(),
  toStatus: sessionStatusSchema,
  fromActivity: nullableActivitySchema,
  toActivity: nullableActivitySchema,
  ts: z.number().int().nonnegative(),
  reason: z.string().min(1),
  actorId: z.string().min(1),
});

// --- Prompt -----------------------------------------------------------------

export const promptSchema = z.object({
  id: z.string().min(1),
  ts: z.number().int().nonnegative(),
  userId: z.string().nullable(),
  promptType: promptTypeSchema,
  content: z.string(),
  modelParamsJson: z.string(),
  tokensIn: z.number().int().nullable(),
  tokensOut: z.number().int().nullable(),
  contextSnapshotJson: z.string().nullable(),
});

// --- Tool call --------------------------------------------------------------

export const toolCallSchema = z.object({
  id: z.string().min(1),
  promptId: z.string().min(1),
  ts: z.number().int().nonnegative(),
  toolName: z.string().min(1),
  argsJson: z.string(),
  resultJson: z.string().nullable(),
  errorDetailsJson: z.string().nullable(),
  status: toolCallStatusSchema,
  durationMs: z.number().int().nullable(),
  exitCode: z.number().int().nullable(),
  retryCount: z.number().int().nonnegative(),
  tokensIn: z.number().int().nullable(),
  tokensOut: z.number().int().nullable(),
});

// --- Artifact ---------------------------------------------------------------

export const artifactSchema = z.object({
  id: z.string().min(1),
  ts: z.number().int().nonnegative(),
  type: artifactTypeSchema,
  storageUri: z.string().min(1),
  generatedBy: artifactGeneratedBySchema,
  mimeType: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  metadataJson: z.string().nullable(),
});

// --- Cost event -------------------------------------------------------------

export const costEventSchema = z.object({
  id: z.number().int().optional(),
  ts: z.number().int().nonnegative(),
  source: costSourceSchema,
  costUsd: z.number().nonnegative(),
  tokensIn: z.number().int().nullable(),
  tokensOut: z.number().int().nullable(),
  model: z.string().nullable(),
  detailJson: z.string().nullable(),
});

// --- Input contracts (the tRPC procedure inputs) ----------------------------

/** Input to session.create (docs/12 §2 spawn). */
export const sessionCreateInputSchema = z.object({
  repoId: z.string().min(1),
  branch: z.string().min(1),
  createdByUserId: z.string().min(1),
  parentSessionId: z.string().optional(),
  budgetLimitUsd: z.number().nonnegative().optional(),
  primaryModel: z.string().optional(),
});

export const sessionCreateResultSchema = z.object({
  sessionId: z.string().min(1),
});

/** Input to session.get. */
export const sessionGetInputSchema = z.object({ sessionId: z.string().min(1) });

/** Input to session.cancel. */
export const sessionCancelInputSchema = z.object({
  sessionId: z.string().min(1),
  reason: z.string().default("human_abort"),
});

/**
 * Input to session.list (docs/07 §4.4 — session list). Scoped to the caller
 * (createdByUserId) by default; optional filters narrow the result set. Cursor
 * pagination on created_at DESC (the natural recency order for a dashboard).
 */
export const sessionListInputSchema = z.object({
  userId: z.string().min(1).optional(),
  repoId: z.string().min(1).optional(),
  status: z
    .enum([
      "queued",
      "active",
      "ready_for_pr",
      "pr_open",
      "merged",
      "closed",
      "no_change",
      "failed",
      "cancelled",
    ])
    .optional(),
  /** Return sessions created strictly before this timestamp (cursor). */
  beforeCreatedAt: z.number().int().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

/** A single row in the session list (the D1 projection shape, docs/12 §3). */
export const sessionSummarySchema = z.object({
  id: z.string(),
  repoId: z.string(),
  branch: z.string(),
  createdByUserId: z.string(),
  status: z.string(),
  activity: z.string().nullable(),
  primaryModel: z.string().nullable(),
  prUrl: z.string().nullable(),
  prNumber: z.number().nullable(),
  createdAt: z.number(),
  endedAt: z.number().nullable(),
  totalCostUsd: z.number(),
  totalTokensIn: z.number(),
  totalTokensOut: z.number(),
  outcome: z.string().nullable(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

/**
 * Input to session.stats (docs/07 §4.4 — conversion funnel + cost/session).
 * Aggregates over a time window for the caller (or a repo).
 */
export const sessionStatsInputSchema = z.object({
  userId: z.string().min(1).optional(),
  repoId: z.string().min(1).optional(),
  /** Only count sessions created at/after this timestamp (unix ms). */
  since: z.number().int().optional(),
});

/** Aggregate session stats (the conversion funnel + cost rollup). */
export const sessionStatsSchema = z.object({
  total: z.number(),
  byStatus: z.record(z.string(), z.number()),
  mergedCount: z.number(),
  failedCount: z.number(),
  cancelledCount: z.number(),
  totalCostUsd: z.number(),
  totalTokensIn: z.number(),
  totalTokensOut: z.number(),
  /** Conversion rate = merged / total (0 when total is 0). */
  mergeRate: z.number(),
  /** Mean cost per session (0 when total is 0). */
  avgCostPerSession: z.number(),
});
export type SessionStats = z.infer<typeof sessionStatsSchema>;

/** Input to prompt.submit (docs/12 §2). */
export const promptSubmitSchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  content: z.string().min(1),
  modelParams: modelParamsSchema.optional(),
});

export const promptSubmitResultSchema = z.object({
  promptId: z.string().min(1),
});

// --- Status response + transition -------------------------------------------

export const sessionStatusResponseSchema = z.object({
  status: sessionStatusSchema,
  activity: nullableActivitySchema,
  costUsd: z.number().nonnegative(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
});

export const transitionTargetSchema = z.object({
  status: sessionStatusSchema.optional(),
  activity: nullableActivitySchema.optional(),
});

export const transitionResultSchema = z.object({
  from: z.object({
    status: sessionStatusSchema.nullable(),
    activity: nullableActivitySchema,
  }),
  to: z.object({
    status: sessionStatusSchema,
    activity: nullableActivitySchema,
  }),
});

// Re-export terminal for consumers needing the narrower view.
export { terminalStatusSchema };
