// Session live-stream event types — seam 3 (docs/10 §4).
// Server→client (DO emits) and client→server (browser calls) over the Agents SDK
// Client SDK / WS at /ws/:sessionId. Typed in domain so the DO emitter and the
// browser consumer share one source of truth.

import type { Artifact, ArtifactType, CostEvent, Prompt, ToolCall } from "./session";
import type { SessionActivity, SessionStatus } from "./state";

/** Discriminator union tag for server→client events. */
export type ServerEventType =
  | "state_snapshot"
  | "thinking_delta"
  | "tool_call"
  | "artifact"
  | "presence"
  | "prompt"
  | "cost"
  | "status_transition"
  | "error";

/** A snapshot of the full session state — sent on connect + on major changes. */
export interface StateSnapshotEvent {
  type: "state_snapshot";
  sessionId: string;
  status: SessionStatus;
  activity: SessionActivity | null;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  history: {
    prompts: Prompt[];
    toolCalls: ToolCall[];
    artifacts: Artifact[];
  };
}

/** An incremental model thinking text delta (docs/10 §4). */
export interface ThinkingDeltaEvent {
  type: "thinking_delta";
  promptId: string;
  delta: string;
}

/** A tool-call event — start/finish/result of a tool invocation. */
export interface ToolCallEvent {
  type: "tool_call";
  promptId: string;
  toolCall: ToolCall;
}

/** A new artifact produced by the agent/user/review agent. */
export interface ArtifactEvent {
  type: "artifact";
  artifact: Artifact;
}

/** Presence update — who is viewing/present in the session (multiplayer, US-1.4). */
export interface PresenceEvent {
  type: "presence";
  presentUserIds: string[];
  // a user joined/left since the last presence event (optional, for UX)
  delta?: { joined: string[]; left: string[] };
}

/** A new prompt was submitted (by this user or another — multiplayer). */
export interface PromptEvent {
  type: "prompt";
  prompt: Prompt;
}

/** A cost event — incremental spend for live cost display. */
export interface CostEvent_ {
  type: "cost";
  event: CostEvent;
}

/** A status/activity transition — the DO notifies watchers on every transition. */
export interface StatusTransitionEvent {
  type: "status_transition";
  from: { status: SessionStatus | null; activity: SessionActivity | null };
  to: { status: SessionStatus; activity: SessionActivity | null };
  reason: string;
  ts: number;
}

/** An error surfaced to the watcher (agent-facing-safe per docs/15 §4). */
export interface ServerErrorEvent {
  type: "error";
  category: string; // ForgeErrorCategory
  retryable: boolean;
  message: string; // safe to show users
  correlationId: string;
  code?: string;
}

/** All server→client events the DO emits on the WS (docs/10 §4). */
export type ServerToClientEvent =
  | StateSnapshotEvent
  | ThinkingDeltaEvent
  | ToolCallEvent
  | ArtifactEvent
  | PresenceEvent
  | PromptEvent
  | CostEvent_
  | StatusTransitionEvent
  | ServerErrorEvent;

// --- Client → server calls (docs/10 §4) ------------------------------------

export interface ClientSubmitPromptCall {
  type: "submit_prompt";
  userId: string;
  content: string;
  modelParams?: { model: string; reasoning?: string; temperature?: number };
}

export interface ClientPauseCall {
  type: "pause";
}

export interface ClientResumeCall {
  type: "resume";
}

export interface ClientCancelCall {
  type: "cancel";
  reason?: string;
}

/** All client→server calls the browser makes over the WS (docs/10 §4). */
export type ClientToServerCall =
  | ClientSubmitPromptCall
  | ClientPauseCall
  | ClientResumeCall
  | ClientCancelCall;

/** A server→client event payload tagged for artifact type narrowing. */
export function isArtifactEvent(e: ServerToClientEvent): e is ArtifactEvent {
  return e.type === "artifact";
}

/** Narrow a server event to a typed tool-call event. */
export function isToolCallEvent(e: ServerToClientEvent): e is ToolCallEvent {
  return e.type === "tool_call";
}

/** Narrow a server event to a thinking-delta event. */
export function isThinkingDeltaEvent(e: ServerToClientEvent): e is ThinkingDeltaEvent {
  return e.type === "thinking_delta";
}

/** Re-export ArtifactType for event consumers. */
export type { ArtifactType };
