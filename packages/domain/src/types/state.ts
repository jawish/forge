// Session lifecycle types — the two-field state model (docs/11_State_Model.md).
//
// `status` (9 values) answers "where is this session in its lifecycle journey?"
// `activity` (5 values) answers "why is/isn't the agent progressing right now?"
//   and is only meaningful when status === 'active'.

/** The 9 lifecycle statuses (docs/11 §2). */
export const SESSION_STATUSES = [
  "queued",
  "active",
  "ready_for_pr",
  "pr_open",
  "merged",
  "closed",
  "no_change",
  "failed",
  "cancelled",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Terminal statuses — no outgoing transitions (docs/11 §2). */
export const TERMINAL_STATUSES = ["merged", "closed", "no_change", "failed", "cancelled"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/** The 5 sub-activities when status === 'active' (docs/11 §3). Null otherwise. */
export const SESSION_ACTIVITIES = [
  "provisioning",
  "running",
  "awaiting_input",
  "paused",
  "stuck",
] as const;
export type SessionActivity = (typeof SESSION_ACTIVITIES)[number];

/** `outcome` set on terminal transition (docs/12 §2 session_meta). */
export const SESSION_OUTCOMES = ["merged", "closed", "no_change", "failed", "cancelled"] as const;
export type SessionOutcome = (typeof SESSION_OUTCOMES)[number];

/** Type guard: is this status terminal? */
export function isTerminalStatus(status: SessionStatus): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** Type guard: can `activity` be non-null under this status? (Only when active.) */
export function activityAllowed(status: SessionStatus): boolean {
  return status === "active";
}
