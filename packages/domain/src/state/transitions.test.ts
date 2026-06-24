import { describe, expect, it } from "vitest";
import {
  ACTIVITY_TRANSITIONS,
  STATUS_TRANSITIONS,
  activityTransitionSideEffects,
  canTransition,
  canTransitionActivity,
  findStatusRule,
  isTerminalStatus,
  isValidState,
  legalActivityFor,
  legalActivityTargets,
  legalStatusTargets,
  transitionSideEffects,
} from "../index";
import { SESSION_ACTIVITIES, SESSION_STATUSES, TERMINAL_STATUSES } from "../index";
import type { SessionActivity, SessionStatus } from "../index";

describe("state machine — status transitions (docs/11 §4)", () => {
  it("every documented transition is legal", () => {
    // Each row in STATUS_TRANSITIONS must report canTransition=true.
    for (const rule of STATUS_TRANSITIONS) {
      expect(canTransition(rule.from, rule.to)).toBe(true);
    }
  });

  it("has exactly the documented set of status transitions (13 rows, docs/11 §4)", () => {
    expect(STATUS_TRANSITIONS).toHaveLength(13);
  });

  it("rejects every illegal transition (terminal states have no outgoing)", () => {
    for (const terminal of TERMINAL_STATUSES) {
      for (const target of SESSION_STATUSES) {
        expect(canTransition(terminal, target)).toBe(false);
      }
    }
  });

  it("rejects self-transitions and undocumented edges", () => {
    for (const from of SESSION_STATUSES) {
      expect(canTransition(from, from)).toBe(false); // no self-loops
    }
    // A few specific undocumented edges must be illegal:
    expect(canTransition("queued", "pr_open")).toBe(false); // skip ready_for_pr
    expect(canTransition("queued", "merged")).toBe(false);
    expect(canTransition("ready_for_pr", "merged")).toBe(false); // must go via pr_open
    expect(canTransition("no_change", "active")).toBe(false); // terminal
  });

  it("legalStatusTargets returns the right set per status", () => {
    expect([...legalStatusTargets("queued")].sort()).toEqual(
      ["active", "cancelled", "failed"].sort(),
    );
    expect([...legalStatusTargets("active")].sort()).toEqual(
      ["cancelled", "failed", "no_change", "ready_for_pr"].sort(),
    );
    expect([...legalStatusTargets("ready_for_pr")].sort()).toEqual(
      ["active", "cancelled", "pr_open"].sort(),
    );
    expect([...legalStatusTargets("pr_open")].sort()).toEqual(
      ["active", "closed", "merged"].sort(),
    );
    // Terminal: no targets.
    for (const terminal of TERMINAL_STATUSES) {
      expect(legalStatusTargets(terminal)).toHaveLength(0);
    }
  });

  it("transitionSideEffects returns the documented manifest for each legal transition", () => {
    for (const rule of STATUS_TRANSITIONS) {
      const fx = transitionSideEffects(rule.from, rule.to);
      expect(fx).toBeDefined();
      expect(fx!.length).toBeGreaterThan(0);
      // Each effect has a stable id (the DO matches on it) + a description.
      for (const e of fx!) {
        expect(typeof e.id).toBe("string");
        expect(e.id.length).toBeGreaterThan(0);
      }
      // The returned manifest equals the rule's (same by value).
      expect(fx).toEqual(rule.sideEffects);
    }
  });

  it("transitionSideEffects returns undefined for illegal transitions", () => {
    expect(transitionSideEffects("merged", "active")).toBeUndefined();
    expect(transitionSideEffects("queued", "queued")).toBeUndefined();
  });

  it("terminal transitions destroy the sandbox", () => {
    // docs/11 §4: sandbox destroyed on terminal transitions that had one.
    const activeToFailed = transitionSideEffects("active", "failed");
    expect(activeToFailed?.some((e) => e.id === "destroy_sandbox")).toBe(true);
    const prToMerged = transitionSideEffects("pr_open", "merged");
    expect(prToMerged?.some((e) => e.id === "destroy_sandbox")).toBe(true);
  });

  it("ready_for_pr -> active restores sandbox + sets activity=running (reopen)", () => {
    const fx = transitionSideEffects("ready_for_pr", "active");
    expect(fx?.some((e) => e.id === "restore_sandbox")).toBe(true);
    expect(fx?.some((e) => e.id === "set_activity_running")).toBe(true);
  });

  it("findStatusRule returns the full rule (guard + side effects)", () => {
    const rule = findStatusRule("ready_for_pr", "pr_open");
    expect(rule).toBeDefined();
    expect(rule!.guard.id).toBe("human_approve_pr");
    expect(rule!.to).toBe("pr_open");
  });

  it("isTerminalStatus flags the 5 terminal statuses", () => {
    for (const s of TERMINAL_STATUSES) expect(isTerminalStatus(s)).toBe(true);
    for (const s of ["queued", "active", "ready_for_pr", "pr_open"] as SessionStatus[]) {
      expect(isTerminalStatus(s)).toBe(false);
    }
  });
});

describe("state machine — activity transitions (docs/11 §5)", () => {
  it("every documented activity transition is legal", () => {
    for (const rule of ACTIVITY_TRANSITIONS) {
      expect(canTransitionActivity(rule.from, rule.to)).toBe(true);
    }
  });

  it("rejects illegal activity transitions", () => {
    expect(canTransitionActivity("provisioning", "paused")).toBe(false); // must run first
    expect(canTransitionActivity("awaiting_input", "stuck")).toBe(false);
    expect(canTransitionActivity("paused", "stuck")).toBe(false);
    expect(canTransitionActivity("provisioning", "provisioning")).toBe(false); // no self-loop
  });

  it("legalActivityTargets per activity (docs/11 §5)", () => {
    expect([...legalActivityTargets("running")].sort()).toEqual(
      ["awaiting_input", "paused", "stuck"].sort(),
    );
    expect(legalActivityTargets("provisioning")).toEqual(["running"]);
  });

  it("activityTransitionSideEffects returns the manifest", () => {
    const fx = activityTransitionSideEffects("running", "paused");
    expect(fx?.some((e) => e.id === "hibernate_sandbox")).toBe(true);
    expect(fx?.some((e) => e.id === "audit_session_paused")).toBe(true);
  });

  it("paused -> running wakes the sandbox + emits resume audit", () => {
    const fx = activityTransitionSideEffects("paused", "running");
    expect(fx?.some((e) => e.id === "wake_restore_sandbox")).toBe(true);
    expect(fx?.some((e) => e.id === "audit_session_resumed")).toBe(true);
  });
});

describe("state machine — activity invariants (docs/11 §1)", () => {
  it("legalActivityFor returns null unless status === active", () => {
    for (const s of [
      "queued",
      "ready_for_pr",
      "pr_open",
      ...TERMINAL_STATUSES,
    ] as SessionStatus[]) {
      expect(legalActivityFor(s)).toBeNull();
    }
  });

  it("legalActivityFor returns the 5 activities when active", () => {
    expect(legalActivityFor("active")).not.toBeNull();
    expect([...(legalActivityFor("active") ?? [])].sort()).toEqual([...SESSION_ACTIVITIES].sort());
  });

  it("isValidState: activity null unless active; required when active", () => {
    // When not active, activity must be null.
    for (const s of ["queued", "ready_for_pr", "merged"] as SessionStatus[]) {
      expect(isValidState(s, null)).toBe(true);
      expect(isValidState(s, "running")).toBe(false);
    }
    // When active, activity is required (non-null).
    expect(isValidState("active", "running")).toBe(true);
    expect(isValidState("active", null)).toBe(false);
  });

  it("every activity in SESSION_ACTIVITIES is valid under active", () => {
    for (const a of SESSION_ACTIVITIES as readonly SessionActivity[]) {
      expect(isValidState("active", a)).toBe(true);
    }
  });
});
