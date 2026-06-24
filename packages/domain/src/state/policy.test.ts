import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPO_POLICY,
  reviewAgentGate,
  shouldTimeoutStuck,
  shouldTripStuck,
  type RepoPolicy,
} from "./transitions";

// Policy gates (docs/11 §6) — Review-Agent guard + stuck-detector thresholds.

const REVIEW_ON: RepoPolicy = { ...DEFAULT_REPO_POLICY, reviewAgentRequired: true };
const REVIEW_OFF: RepoPolicy = { ...DEFAULT_REPO_POLICY, reviewAgentRequired: false };

describe("reviewAgentGate — active → ready_for_pr policy (docs/11 §6, US-4.2)", () => {
  it("allows the transition when review is not required", () => {
    const r = reviewAgentGate({ policy: REVIEW_OFF, verdict: "pending" });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("review_agent_not_required");
  });

  it("allows when review is required AND the verdict is approve", () => {
    expect(reviewAgentGate({ policy: REVIEW_ON, verdict: "approve" })).toEqual({
      allowed: true,
      reason: "review_approved",
    });
  });

  it("blocks when review is required AND the verdict is pending", () => {
    const r = reviewAgentGate({ policy: REVIEW_ON, verdict: "pending" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("review_pending");
  });

  it("blocks when review is required AND the verdict is request_changes", () => {
    const r = reviewAgentGate({ policy: REVIEW_ON, verdict: "request_changes" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("review_requested_changes");
  });
});

describe("stuck-detector thresholds (docs/11 §5, §6)", () => {
  it("shouldTripStuck trips at the threshold (default 10 turns)", () => {
    expect(shouldTripStuck({ policy: DEFAULT_REPO_POLICY, turnsWithoutProgress: 9 })).toBe(false);
    expect(shouldTripStuck({ policy: DEFAULT_REPO_POLICY, turnsWithoutProgress: 10 })).toBe(true);
  });

  it("respects a stricter per-repo threshold (high-sensitivity: 5 turns)", () => {
    const strict: RepoPolicy = { ...DEFAULT_REPO_POLICY, stuckThresholdTurns: 5 };
    expect(shouldTripStuck({ policy: strict, turnsWithoutProgress: 4 })).toBe(false);
    expect(shouldTripStuck({ policy: strict, turnsWithoutProgress: 5 })).toBe(true);
  });

  it("shouldTimeoutStuck times out at the threshold (default 5 min)", () => {
    expect(shouldTimeoutStuck({ policy: DEFAULT_REPO_POLICY, stuckForMinutes: 4 })).toBe(false);
    expect(shouldTimeoutStuck({ policy: DEFAULT_REPO_POLICY, stuckForMinutes: 5 })).toBe(true);
  });

  it("respects a stricter timeout (high-sensitivity: 3 min)", () => {
    const strict: RepoPolicy = { ...DEFAULT_REPO_POLICY, stuckTimeoutMinutes: 3 };
    expect(shouldTimeoutStuck({ policy: strict, stuckForMinutes: 3 })).toBe(true);
  });
});
