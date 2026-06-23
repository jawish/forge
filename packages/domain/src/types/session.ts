// Session domain entities — DO SQLite hot state (docs/12 §2) + state model (docs/11).
// These are the plain TS types; zod runtime schemas live in src/schemas/.

import type { SessionActivity, SessionOutcome, SessionStatus } from "./state";

/** A single unit of agentic work against one repo on one branch (CONTEXT.md). */
export interface Session {
  id: string; // session id (= DO id)
  repoId: string;
  branch: string;
  createdByUserId: string;
  parentSessionId: string | null; // null for roots
  rootSessionId: string; // = id for roots; ancestry chain head
  status: SessionStatus;
  activity: SessionActivity | null; // null when status !== 'active' (docs/11 §1)
  primaryModel: string | null; // e.g. 'claude-sonnet-4-6'
  sandboxImageVersion: string | null;
  sandboxId: string | null; // CF Sandbox instance id (null until provisioned)
  prUrl: string | null;
  prNumber: number | null;
  createdAt: number; // unix ms
  endedAt: number | null;
  mergedAt: number | null;
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  budgetLimitUsd: number | null; // per-session cap (null = inherit team default)
  outcome: SessionOutcome | null; // set on terminal transition
  failureReason: string | null;
}

/** Append-only status-transition log row (docs/12 §2 status_history). */
export interface StatusHistoryEntry {
  id?: number;
  fromStatus: SessionStatus | null;
  toStatus: SessionStatus;
  fromActivity: SessionActivity | null;
  toActivity: SessionActivity | null;
  ts: number; // unix ms
  reason: string; // 'human_approve' | 'budget_exhausted' | 'stuck_timeout' | ...
  actorId: string; // user id or 'system'
}

/** A single user/system instruction submitted to a session (CONTEXT.md). */
export type PromptType = "user" | "agent_internal" | "system";

export interface Prompt {
  id: string;
  ts: number;
  userId: string | null; // null for system/agent-internal prompts
  promptType: PromptType;
  content: string; // redacted copy for storage; raw in memory only
  modelParamsJson: string; // {model, reasoning, temperature} snapshot for this turn
  tokensIn: number | null;
  tokensOut: number | null;
  contextSnapshotJson: string | null;
}

/** Model params snapshot captured per prompt/turn (docs/12 §2 prompt.model_params_json). */
export interface ModelParams {
  model: string;
  reasoning?: string; // reasoning effort hint
  temperature?: number;
}

/** One invocation of a tool by the agent (CONTEXT.md). */
export type ToolCallStatus = "success" | "error" | "timeout" | "cancelled";

export interface ToolCall {
  id: string;
  promptId: string;
  ts: number;
  toolName: string; // 'read_file' | 'rg' | 'run_tests' | MCP tool name | ...
  argsJson: string; // sanitized (secrets redacted)
  resultJson: string | null; // sanitized
  errorDetailsJson: string | null;
  status: ToolCallStatus;
  durationMs: number | null;
  exitCode: number | null;
  retryCount: number;
  tokensIn: number | null;
  tokensOut: number | null;
}

/** A durable output of a session (CONTEXT.md). Stored as R2 blob + typed metadata. */
export type ArtifactType =
  | "diff"
  | "test_result"
  | "screenshot"
  | "telemetry"
  | "report"
  | "review_critique";
export type ArtifactGeneratedBy = "agent" | "user" | "review_agent";

export interface Artifact {
  id: string;
  ts: number;
  type: ArtifactType;
  storageUri: string; // R2 URI (blobs live in R2, not DO)
  generatedBy: ArtifactGeneratedBy;
  mimeType: string | null;
  sizeBytes: number | null;
  metadataJson: string | null;
}

/** Incremental cost ledger row for synchronous budget enforcement (docs/12 §2 cost_event). */
export type CostSource = "model" | "sandbox_cpu" | "sandbox_egress" | "browser_run" | "other";

export interface CostEvent {
  id?: number;
  ts: number;
  source: CostSource;
  costUsd: number;
  tokensIn: number | null; // null for non-model sources
  tokensOut: number | null;
  model: string | null; // null for non-model sources
  detailJson: string | null; // provider, gateway request id, etc.
}

/** Reason a session was cancelled (docs/12 §2 DO API). */
export type CancelReason = string; // 'human_abort' | 'admin_force' | ... — open set
