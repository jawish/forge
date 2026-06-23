// SessionDO — the Durable Object holding per-session hot state (docs/12 §2).
// Minimal stub for §4 (so the wrangler binding resolves + the worker boots).
// The real SQLite schema + DO API (spawn/transitionTo/cancel/...) lands in §5.1–5.2.

import { Agent } from "@cloudflare/agents";
import type { Env } from "../env";

/**
 * SessionDO. Uses @cloudflare/agents' Agent base (WS hibernation, RPC, SQLite)
 * per ADR-0004. The full state machine (docs/11), SQLite tables (docs/12 §2),
 * and DO API surface are implemented in §5.1–5.3.
 *
 * State (§5.1): the cached session_meta (status/activity/cost). The source of
 * truth for live state; D1/R2/ClickHouse are one-way projections.
 */
export interface SessionDOState {
  sessionId: string | null;
  status: string | null;
  activity: string | null;
}

export class SessionDO extends Agent<Env, SessionDOState> {
  // §5.1 adds the migration (SQLite tables) + the DO API methods.
  // §5.2 adds spawn/transitionTo/cancel/submitPrompt/.../completePR.
  // §5.3 wires the domain state machine into transitionTo.

  /** Stub: acknowledges WS connect. §5.11–5.13 wires the full event stream. */
  override onConnect(): void {
    // no-op until §5 wires the live stream
  }
}
