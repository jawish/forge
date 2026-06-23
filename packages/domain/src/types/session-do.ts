// The in-process DO API surface — seam 2 (docs/10 §3, docs/12 §2 DO API).
// The control-plane Worker calls these methods directly via env.SESSION_DO.get(id).
// No serialization framework beyond structured clone (CF's default for DO args).

import type { Artifact, ArtifactType, CancelReason, Prompt, ToolCall } from "./session";
import type { SessionActivity, SessionStatus } from "./state";

/** Input to SessionDO.spawn (docs/12 §2). */
export interface SessionSpawnInput {
  repoId: string;
  branch: string;
  createdByUserId: string;
  parentSessionId?: string;
  budgetLimitUsd?: number;
  primaryModel?: string;
}

export interface SessionSpawnResult {
  sessionId: string;
}

/** A status/activity transition target (docs/12 §2 transitionTo). */
export interface TransitionTarget {
  status?: SessionStatus;
  activity?: SessionActivity | null;
}

export interface TransitionResult {
  from: { status: SessionStatus | null; activity: SessionActivity | null };
  to: { status: SessionStatus; activity: SessionActivity | null };
}

/** Input to SessionDO.submitPrompt (docs/12 §2). */
export interface PromptSubmitInput {
  userId: string;
  content: string;
  modelParams?: {
    model: string;
    reasoning?: string;
    temperature?: number;
  };
}

export interface PromptSubmitResult {
  promptId: string;
}

/** Return of SessionDO.getStatus (docs/12 §2). */
export interface SessionStatusResponse {
  status: SessionStatus;
  activity: SessionActivity | null;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  // ... other session_meta fields as needed by callers
  [key: string]: unknown;
}

export interface CancelResult {
  status: SessionStatus;
}

/** Options for getHistory (docs/12 §2). */
export interface GetHistoryOpts {
  sinceTs?: number;
  limit?: number;
}

export interface SessionHistory {
  prompts: Prompt[];
  toolCalls: ToolCall[];
  artifacts: Artifact[];
}

/** Input to SessionDO.createArtifact (seam 5 MCP tool, docs/12 §2). */
export interface ArtifactInput {
  type: ArtifactType;
  storageUri: string;
  generatedBy: "agent" | "user" | "review_agent";
  mimeType?: string;
  sizeBytes?: number;
  metadataJson?: string;
}

export interface CreateArtifactResult {
  artifactId: string;
}

/** Input to SessionDO.reportStatus (seam 5, docs/10 §6). */
export interface ReportStatusInput {
  activity?: SessionActivity;
  summary?: string;
}

/** Input to SessionDO.completePR (seam 5, docs/10 §6). */
export interface CompletePRInput {
  diffSummary: string;
  commitSha: string;
}

/**
 * The DO API contract (docs/12 §2). The DO stub (env.SESSION_DO) is typed by
 * this interface. Implementations live in apps/control-plane (§5.1–5.2).
 */
export interface SessionDOInterface {
  // Lifecycle
  spawn(input: SessionSpawnInput): Promise<SessionSpawnResult>;
  transitionTo(to: TransitionTarget, reason: string): Promise<TransitionResult>;
  cancel(reason: CancelReason): Promise<CancelResult>;

  // Prompts + streaming
  submitPrompt(input: PromptSubmitInput): Promise<PromptSubmitResult>;
  pause(): Promise<void>;
  resume(): Promise<void>;

  // Reads
  getStatus(): Promise<SessionStatusResponse>;
  getHistory(opts?: GetHistoryOpts): Promise<SessionHistory>;

  // Agent callbacks (seam 5 — MCP tools call these)
  reportStatus(status: ReportStatusInput): Promise<void>;
  createArtifact(artifact: ArtifactInput): Promise<CreateArtifactResult>;
  requestHumanInput(question: string): Promise<void>;
  completePR(changes: CompletePRInput): Promise<void>;
}
