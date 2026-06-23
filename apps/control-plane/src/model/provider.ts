// Model provider interface — behind the AI Gateway (docs/08 §6, checklist §4.4).
// The same interface is implemented by:
//   - MockModelProvider   (fast profile: canned streaming fixtures)
//   - AiGatewayModelClient (real profile: real models via CF AI Gateway — §6.4)
//
// Streaming: the model yields typed ModelEvent deltas (thinking text, tool calls,
// completion). These map to the seam-3 WS events (docs/10 §4) emitted by the DO.

/** A model-streaming event. The harness consumes these to drive the agent loop. */
export type ModelEvent =
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call"; toolName: string; args: Record<string, unknown> }
  | { type: "request_human_input"; question: string }
  | { type: "complete_pr"; diffSummary: string; commitSha: string }
  | { type: "finish"; reason: "stop" | "length" | "tool_use" };

/** Input to a model stream — a prompt + the session context. */
export interface ModelStreamInput {
  prompt: string;
  /** Which model to use (tier default or per-session override). */
  model: string;
  /** Recent history + git SHA + dirty-state summary (docs/12 §2 prompt.context_snapshot_json). */
  contextSnapshot?: string;
}

/**
 * A model provider streams ModelEvents for a prompt. AsyncIterable so callers
 * can `for await` the deltas. The fast profile's mock yields canned fixtures;
 * the real profile's AI Gateway client streams real model output.
 */
export interface ModelProvider {
  /** Stream events for a single prompt turn. */
  stream(input: ModelStreamInput): AsyncIterable<ModelEvent>;
  /** Which provider this is (for spans/logging). */
  readonly name: string;
}
