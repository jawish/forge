// Session state machine — pure functions for the transition tables in
// docs/11 §4 (status) + §5 (activity). The DO uses these to validate legality
// (docs/11 §7) and to know which side effects to fire on each transition.
//
// This is pure logic — the DO (apps/control-plane §5.1–5.3) implements the
// side-effect *manifests* returned here against injected ports, so they're testable.

import type { SessionActivity, SessionStatus } from "../types/state";
import { isTerminalStatus } from "../types/state";

// ---------------------------------------------------------------------------
// STATUS transitions (docs/11 §4)
// ---------------------------------------------------------------------------

/** Reason categories that drive transitions (docs/12 §2 status_history.reason). */
export type TransitionReason =
  | "sandbox_provisioned"
  | "provisioning_failed"
  | "human_cancel_before_start"
  | "agent_complete_pr"
  | "agent_no_change"
  | "error_or_budget_or_stuck"
  | "human_cancel_mid_session"
  | "human_approve_pr"
  | "human_request_changes"
  | "human_reject"
  | "pr_merged"
  | "pr_closed"
  | "reopen_from_pr"
  | string; // open set; known values enumerated for side-effect matching

/** A guard predicate (policy) — configurable per repo (docs/11 §6). */
export interface TransitionGuard {
  readonly id: string; // e.g. 'sandbox_provisioned', 'human_approve_pr'
  readonly description: string;
}

/** A side effect the DO must run on this transition (docs/11 §4). */
export interface SideEffect {
  readonly id: string; // stable label for the DO to match on
  readonly description: string;
}

/** A legal status transition row from docs/11 §4. */
export interface StatusTransitionRule {
  readonly from: SessionStatus;
  readonly to: SessionStatus;
  readonly guard: TransitionGuard;
  readonly sideEffects: readonly SideEffect[];
}

const se = (id: string, description: string): SideEffect => ({ id, description });
const guard = (id: string, description: string): TransitionGuard => ({ id, description });

/** The full status transition table (docs/11 §4), verbatim. */
export const STATUS_TRANSITIONS: readonly StatusTransitionRule[] = [
  {
    from: "queued",
    to: "active",
    guard: guard("sandbox_provisioned", "Sandbox provisioned successfully"),
    sideEffects: [
      se("start_cost_counter", "Start cost counter"),
      se("audit_session_started", "Emit SessionStarted audit event"),
      se("slack_thread_started", 'Post Slack thread "started"'),
    ],
  },
  {
    from: "queued",
    to: "failed",
    guard: guard("provisioning_failed", "Provisioning failed (image pull, capacity)"),
    sideEffects: [
      se("audit_session_failed", "Emit SessionFailed audit"),
      se("slack_thread_failed_to_start", 'Post Slack thread "failed to start"'),
    ],
  },
  {
    from: "queued",
    to: "cancelled",
    guard: guard("human_cancel_before_start", "Human cancels before start"),
    sideEffects: [
      se("audit_session_cancelled", "Emit SessionCancelled audit (no sandbox cleanup)"),
    ],
  },
  {
    from: "active",
    to: "ready_for_pr",
    guard: guard("agent_complete_pr", "Agent calls forge.completePR with staged changes"),
    sideEffects: [
      se("snapshot_sandbox", "Snapshot sandbox"),
      se("review_agent_artifacts", "Generate Review Agent artifacts (if enabled)"),
      se("slack_thread_ready", 'Post Slack thread "ready for review"'),
      se("set_activity_null", "Set activity = null"),
    ],
  },
  {
    from: "active",
    to: "no_change",
    guard: guard("agent_no_change", "Agent finishes with no staged changes"),
    sideEffects: [
      se("audit_session_completed", "Emit SessionCompleted audit"),
      se("slack_thread_no_changes", 'Post Slack thread "no changes needed"'),
      se("destroy_sandbox", "Destroy sandbox"),
    ],
  },
  {
    from: "active",
    to: "failed",
    guard: guard("error_budget_stuck", "Error, budget exhausted, or stuck-timeout"),
    sideEffects: [
      se("audit_session_failed_reason", "Emit SessionFailed audit (with reason)"),
      se("capture_diagnostic_snapshot", "Capture diagnostic snapshot"),
      se("slack_thread_failed", 'Post Slack thread "failed"'),
      se("destroy_sandbox", "Destroy sandbox"),
    ],
  },
  {
    from: "active",
    to: "cancelled",
    guard: guard("human_cancel_mid_session", "Human cancels mid-session"),
    sideEffects: [
      se("audit_session_cancelled", "Emit SessionCancelled audit"),
      se("slack_thread_cancelled", 'Post Slack thread "cancelled"'),
      se("destroy_sandbox", "Destroy sandbox"),
    ],
  },
  {
    from: "ready_for_pr",
    to: "pr_open",
    guard: guard("human_approve_pr", "Human approves PR creation (tRPC session.approvePR)"),
    sideEffects: [
      se("create_pr_oauth", "Create PR via user's GitHub OAuth"),
      se("set_pr_url_number", "Set pr_url/pr_number"),
      se("audit_pr_created", "Emit PRCreated audit"),
      se("slack_thread_pr_opened", 'Post Slack thread "PR opened"'),
    ],
  },
  {
    from: "ready_for_pr",
    to: "active",
    guard: guard("human_request_changes", 'Human requests changes ("not ready, do more")'),
    sideEffects: [
      se("restore_sandbox", "Restore sandbox from snapshot"),
      se("set_activity_running", "Set activity = running"),
      se("slack_thread_reopened", 'Post Slack thread "reopened"'),
    ],
  },
  {
    from: "ready_for_pr",
    to: "cancelled",
    guard: guard("human_reject", "Human rejects"),
    sideEffects: [
      se("audit_session_cancelled", "Emit SessionCancelled audit"),
      se("destroy_sandbox", "Destroy sandbox"),
    ],
  },
  {
    from: "pr_open",
    to: "merged",
    guard: guard("pr_merged", "GitHub webhook: PR merged"),
    sideEffects: [
      se("audit_pr_merged", "Emit PRMerged audit"),
      se("capture_final_cost", "Capture final cost"),
      se("archive_session", "Archive session"),
      se("destroy_sandbox", "Destroy sandbox"),
    ],
  },
  {
    from: "pr_open",
    to: "closed",
    guard: guard("pr_closed", "GitHub webhook: PR closed without merge"),
    sideEffects: [
      se("audit_pr_closed", "Emit PRClosed audit"),
      se("archive_session", "Archive session"),
      se("destroy_sandbox", "Destroy sandbox"),
    ],
  },
  {
    from: "pr_open",
    to: "active",
    guard: guard("reopen_from_pr", "(Optional) Reopen path: human wants more work after PR closed"),
    sideEffects: [
      se("restore_sandbox", "Restore sandbox"),
      se("set_activity_running", "Set activity = running"),
    ],
  },
];

/** Is transitioning from `statusFrom` to `statusTo` legal? (docs/11 §4) */
export function canTransition(statusFrom: SessionStatus, statusTo: SessionStatus): boolean {
  return STATUS_TRANSITIONS.some((r) => r.from === statusFrom && r.to === statusTo);
}

/** All legal `to` statuses from a given `from` status. */
export function legalStatusTargets(statusFrom: SessionStatus): readonly SessionStatus[] {
  return STATUS_TRANSITIONS.filter((r) => r.from === statusFrom).map((r) => r.to);
}

/**
 * The side-effect manifest for a transition (docs/11 §4). The DO matches on
 * `sideEffect.id` to invoke the right port. Throws nothing here — returns
 * `undefined` for illegal transitions (callers use canTransition first, or
 * the DO wraps in IllegalTransitionError).
 */
export function transitionSideEffects(
  statusFrom: SessionStatus,
  statusTo: SessionStatus,
): readonly SideEffect[] | undefined {
  const rule = STATUS_TRANSITIONS.find((r) => r.from === statusFrom && r.to === statusTo);
  return rule?.sideEffects;
}

/** The guard for a transition (docs/11 §4). */
export function transitionGuard(
  statusFrom: SessionStatus,
  statusTo: SessionStatus,
): TransitionGuard | undefined {
  const rule = STATUS_TRANSITIONS.find((r) => r.from === statusFrom && r.to === statusTo);
  return rule?.guard;
}

/** The full rule for a transition (guard + side effects). */
export function findStatusRule(
  statusFrom: SessionStatus,
  statusTo: SessionStatus,
): StatusTransitionRule | undefined {
  return STATUS_TRANSITIONS.find((r) => r.from === statusFrom && r.to === statusTo);
}

/** Is `status` terminal? (docs/11 §2) — re-exported from types/state. */
export { isTerminalStatus };

// ---------------------------------------------------------------------------
// ACTIVITY transitions (docs/11 §5) — only when status === 'active'
// ---------------------------------------------------------------------------

export interface ActivityTransitionRule {
  readonly from: SessionActivity;
  readonly to: SessionActivity;
  readonly guard: TransitionGuard;
  readonly sideEffects: readonly SideEffect[];
}

/** The activity transition table (docs/11 §5), verbatim. */
export const ACTIVITY_TRANSITIONS: readonly ActivityTransitionRule[] = [
  {
    from: "provisioning",
    to: "running",
    guard: guard("first_thinking_event", "First agent thinking event received"),
    sideEffects: [
      se("mark_truly_active", "Mark session truly active in OTel"),
      se("audit_agent_started", "Emit AgentStarted audit"),
    ],
  },
  {
    from: "running",
    to: "awaiting_input",
    guard: guard("agent_request_input", "Agent calls forge.requestHumanInput"),
    sideEffects: [
      se("slack_thread_needs_input", 'Post Slack thread "needs input"'),
      se("notify_watchers_ws", "Notify watchers via WS"),
    ],
  },
  {
    from: "awaiting_input",
    to: "running",
    guard: guard("human_submit_prompt", "Human submits prompt (tRPC or MCP)"),
    sideEffects: [
      se("clear_needs_input", 'Clear "needs input" flag'),
      se("resume_streaming", "Resume streaming"),
    ],
  },
  {
    from: "running",
    to: "paused",
    guard: guard("human_pause", "Human pauses (tRPC session.pause)"),
    sideEffects: [
      se("hibernate_sandbox", "Hibernate sandbox (sleepAfter override)"),
      se("audit_session_paused", "Emit SessionPaused audit"),
    ],
  },
  {
    from: "paused",
    to: "running",
    guard: guard("human_resume", "Human resumes (tRPC session.resume)"),
    sideEffects: [
      se("wake_restore_sandbox", "Wake/restore sandbox"),
      se("audit_session_resumed", "Emit SessionResumed audit"),
    ],
  },
  {
    from: "running",
    to: "stuck",
    guard: guard("stuck_detector", "Stuck-detector triggers (no progress for N turns)"),
    sideEffects: [
      se("emit_session_stuck_metric", "Emit SessionStuck metric"),
      se("alert_oncall_optional", "Optionally alert on-call"),
    ],
  },
  {
    from: "stuck",
    to: "running",
    guard: guard("agent_makes_progress", "Agent makes progress (file edit / successful tool call)"),
    sideEffects: [se("clear_stuck_flag", "Clear stuck flag")],
  },
  // stuck -> (status -> failed) is a STATUS transition (stuck_timeout), handled in the
  // active -> failed row above under guard 'error_budget_stuck'.
];

/** Can `activity` transition from→to? (docs/11 §5) */
export function canTransitionActivity(
  activityFrom: SessionActivity,
  activityTo: SessionActivity,
): boolean {
  return ACTIVITY_TRANSITIONS.some((r) => r.from === activityFrom && r.to === activityTo);
}

/** Legal activity targets from a given activity. */
export function legalActivityTargets(activityFrom: SessionActivity): readonly SessionActivity[] {
  return ACTIVITY_TRANSITIONS.filter((r) => r.from === activityFrom).map((r) => r.to);
}

/** Side-effect manifest for an activity transition (docs/11 §5). */
export function activityTransitionSideEffects(
  activityFrom: SessionActivity,
  activityTo: SessionActivity,
): readonly SideEffect[] | undefined {
  const rule = ACTIVITY_TRANSITIONS.find((r) => r.from === activityFrom && r.to === activityTo);
  return rule?.sideEffects;
}

/**
 * legalActivityFor — which activities are valid given a status (docs/11 §1, §5).
 * activity is nullable; non-null only when status === 'active'.
 * Returns the set of legal non-null activities, or null if activity must be null.
 */
export function legalActivityFor(status: SessionStatus): readonly SessionActivity[] | null {
  if (status !== "active") return null; // activity must be null when not active
  // When active, the full activity set is reachable (subject to transition legality).
  return ["provisioning", "running", "awaiting_input", "paused", "stuck"] as const;
}

/**
 * Validate a (status, activity) pairing for the invariant:
 * activity is non-null ONLY when status === 'active' (docs/11 §1).
 */
export function isValidState(status: SessionStatus, activity: SessionActivity | null): boolean {
  if (status !== "active") return activity === null;
  return activity !== null; // when active, activity is required (never null)
}
