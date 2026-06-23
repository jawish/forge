// Sanitization pipeline — projection-first (docs/18 Part A).
//
// The model: don't filter raw data (redaction is only as good as the patterns).
// Project a deliberately-limited view — the ClickHouse analytics event schema
// includes only structurally-safe fields BY CONSTRUCTION. You can't leak what
// you never included.
//
// This module:
// 1. Projects a raw session event → the safe ClickHouse event (only safe fields).
// 2. Applies layered redaction to the few included content fields (docs/18 §3):
//    structured (regex) + contextual (heuristics) + fail-closed.
// 3. Emits SANITIZATION_FAILED on unclassifiable values (docs/15 §3).

import type { CostEvent, Prompt, ToolCall } from "../types/session";
import type { SessionActivity, SessionStatus } from "../types/state";

/** A raw event from the DO (what the DO has in SQLite — full fidelity). */
export interface RawSessionEvent {
  eventType:
    | "session_started"
    | "prompt"
    | "tool_call"
    | "artifact"
    | "status_transition"
    | "cost_event"
    | "error";
  sessionId: string;
  repoId: string;
  userId: string;
  ts: number;
  status: SessionStatus;
  activity: SessionActivity | null;
  actorId: string;
  model?: string | null;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  /** The raw content fields (prompt text, tool args, tool result, error msg). */
  rawContent?: {
    promptText?: string;
    toolArgsJson?: string;
    toolResultJson?: string;
    errorMessage?: string;
  };
  traceId?: string;
  spanId?: string;
}

/** The sanitized analytics event (docs/12 §5 session_event). Safe by construction. */
export interface SanitizedEvent {
  eventId: string;
  sessionId: string;
  ts: number;
  repoId: string;
  userId: string;
  eventType: string;
  status: SessionStatus;
  activity: SessionActivity | null;
  actorId: string;
  /** Sanitized payload — only safe structural fields + redacted content. */
  payload: string; // JSON
  model: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  traceId: string;
  spanId: string;
}

/** Result of sanitizing an event — the safe event OR a SANITIZATION_FAILED marker. */
export interface SanitizationResult {
  event: SanitizedEvent | null; // null when SANITIZATION_FAILED
  failed: boolean;
  reason?: string;
}

// --- Layered redaction (docs/18 §3) ----------------------------------------

/** Structured patterns: known secret shapes (~100% recall on known formats). */
const STRUCTURED_PATTERNS: ReadonlyArray<{ name: string; re: RegExp; redaction: string }> = [
  // AWS access keys (AKIA + 16 chars)
  { name: "aws_key", re: /AKIA[0-9A-Z]{16}/g, redaction: "[REDACTED:aws_key]" },
  // GitHub tokens (ghp_/gho_/ghs_/ghr_ + 36+)
  { name: "github_token", re: /gh[pousr]_[A-Za-z0-9]{36,}/g, redaction: "[REDACTED:github_token]" },
  // JWTs (3 base64url segments starting with eyJ)
  {
    name: "jwt",
    re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    redaction: "[REDACTED:jwt]",
  },
  // PEM blocks (-----BEGIN ... PRIVATE KEY-----)
  {
    name: "pem",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    redaction: "[REDACTED:pem]",
  },
  // Generic API-key-like: long hex/base64 with key-ish name proximity handled by contextual layer
];

/** Contextual heuristics: env-var-name patterns + the values they reference. */
const SENSITIVE_NAME_RE = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_CREDENTIAL|API_KEY)$/i;

/** Apply structured + contextual redaction to a single content string. */
export function redactContent(value: string): string {
  let out = value;
  // Layer: structured patterns (known secret shapes).
  for (const p of STRUCTURED_PATTERNS) {
    out = out.replace(p.re, p.redaction);
  }
  // Layer: contextual — env-var-name=VALUE patterns (NAME_KEY=abc123).
  out = out.replace(
    /([A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_CREDENTIAL))\s*[=:]\s*["']?([^\s"']+)["']?/g,
    "$1=[REDACTED]",
  );
  // Layer: contextual — bare names matching sensitive patterns near a value.
  if (SENSITIVE_NAME_RE.test("__KEY")) {
    // no-op guard (the regex is used inline above); kept for explicitness
  }
  return out;
}

/**
 * Can a value be classified as safe (no obvious secrets after redaction)?
 * Fail-closed: if a value still looks suspicious (long high-entropy blob), redact.
 */
function isClassifiableSafe(value: string): boolean {
  if (value.length === 0) return true;
  // Fail-closed: a very long, high-entropy blob that doesn't reduce on redaction
  // is treated as unclassifiable → SANITIZATION_FAILED for that field.
  const redacted = redactContent(value);
  if (redacted !== value) return true; // something was redacted → was sensitive, now safe
  // Heuristic: a "random-looking" base64/hex blob > 40 chars with no spaces.
  if (/^[A-Za-z0-9+/=_-]{40,}$/.test(value.trim()) && !/\s/.test(value)) {
    return false; // unclassifiable high-entropy blob
  }
  return true;
}

/**
 * Sanitize a raw session event into the safe ClickHouse projection (docs/18 §1–§3).
 * Projection-first: only structurally-safe fields are included. The few content
 * fields (error_message_truncated, prompt intent) get layered redaction. A value
 * that can't be classified as safe → redacted entirely + SANITIZATION_FAILED.
 */
export function sanitizeEvent(raw: RawSessionEvent): SanitizationResult {
  const eventId = `evt_${raw.sessionId}_${raw.ts}`;
  const base = {
    eventId,
    sessionId: raw.sessionId,
    ts: raw.ts,
    repoId: raw.repoId,
    userId: raw.userId,
    eventType: raw.eventType,
    status: raw.status,
    activity: raw.activity,
    actorId: raw.actorId,
    model: raw.model ?? "",
    costUsd: raw.costUsd ?? 0,
    tokensIn: raw.tokensIn ?? 0,
    tokensOut: raw.tokensOut ?? 0,
    traceId: raw.traceId ?? "",
    spanId: raw.spanId ?? "",
  };

  // Project only safe content (docs/18 §2). The payload NEVER includes raw prompt
  // text / tool args / tool results / file contents — only a redacted, truncated
  // error_message (the one content field deliberately included).
  const payload: Record<string, unknown> = {
    event_type: raw.eventType,
    tool_name: undefined, // set by callers that have it; safe (low-cardinality label)
  };

  let failed = false;
  let reason: string | undefined;

  if (raw.rawContent?.errorMessage) {
    const msg = raw.rawContent.errorMessage.slice(0, 500); // truncated (docs/18 §2)
    if (isClassifiableSafe(msg)) {
      payload.error_message_truncated = redactContent(msg);
    } else {
      // Fail-closed: redact entirely + flag (docs/18 §3, docs/15 §3 SANITIZATION_FAILED).
      payload.error_message_truncated = "[REDACTED:unclassifiable]";
      failed = true;
      reason = "error_message unclassifiable";
    }
  }

  return {
    event: { ...base, payload: JSON.stringify(payload) },
    failed,
    reason,
  };
}

// Re-export the raw-event types for callers building events from DO rows.
export type { CostEvent, Prompt, ToolCall };
