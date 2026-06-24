import { describe, expect, it } from "vitest";
import {
  decideSampling,
  isSkeletonSpan,
  promoteOnTerminal,
  shouldEmitLive,
  shouldFlushOnTransition,
} from "./sampling";
import type { SessionStatus } from "@forge/domain";

// Session-scoped sampling + status-aware promotion (docs/14 §4). Pure-logic tests.

describe("decideSampling (docs/14 §4)", () => {
  it("rolls ~20% to full (roll < 20)", () => {
    expect(decideSampling({ samplingRoll: 0 })).toBe("full");
    expect(decideSampling({ samplingRoll: 19 })).toBe("full");
    expect(decideSampling({ samplingRoll: 20 })).toBe("skeleton");
    expect(decideSampling({ samplingRoll: 99 })).toBe("skeleton");
  });
  it("high-sensitivity repos are always full", () => {
    expect(decideSampling({ samplingRoll: 99, highSensitivity: true })).toBe("full");
  });
  it("respects a custom full rate", () => {
    expect(decideSampling({ samplingRoll: 49, fullRatePercent: 50 })).toBe("full");
    expect(decideSampling({ samplingRoll: 50, fullRatePercent: 50 })).toBe("skeleton");
  });
});

describe("shouldEmitLive (docs/14 §4)", () => {
  it("full tier emits everything", () => {
    expect(shouldEmitLive({ tier: "full", isSkeletonSpan: false })).toBe(true);
    expect(shouldEmitLive({ tier: "full", isSkeletonSpan: true })).toBe(true);
  });
  it("skeleton tier emits only skeleton spans", () => {
    expect(shouldEmitLive({ tier: "skeleton", isSkeletonSpan: true })).toBe(true);
    expect(shouldEmitLive({ tier: "skeleton", isSkeletonSpan: false })).toBe(false);
  });
});

describe("isSkeletonSpan", () => {
  it("the skeleton set is spawn/transition/cancel", () => {
    expect(isSkeletonSpan("session.spawn")).toBe(true);
    expect(isSkeletonSpan("session.transition")).toBe(true);
    expect(isSkeletonSpan("session.cancel")).toBe(true);
    expect(isSkeletonSpan("prompt.stream")).toBe(false);
    expect(isSkeletonSpan("tool.call")).toBe(false);
  });
});

describe("promoteOnTerminal + shouldFlushOnTransition (docs/14 §4)", () => {
  it("promotes skeleton → full on failed/closed (the learning signal)", () => {
    expect(promoteOnTerminal("skeleton", "failed" as SessionStatus)).toBe("full");
    expect(promoteOnTerminal("skeleton", "closed" as SessionStatus)).toBe("full");
  });
  it("does NOT promote on merged/no_change/cancelled (success/neutral outcomes)", () => {
    expect(promoteOnTerminal("skeleton", "merged" as SessionStatus)).toBe("skeleton");
    expect(promoteOnTerminal("skeleton", "no_change" as SessionStatus)).toBe("skeleton");
    expect(promoteOnTerminal("skeleton", "cancelled" as SessionStatus)).toBe("skeleton");
  });
  it("full stays full regardless of outcome", () => {
    expect(promoteOnTerminal("full", "failed" as SessionStatus)).toBe("full");
    expect(promoteOnTerminal("full", "merged" as SessionStatus)).toBe("full");
  });
  it("shouldFlushOnTransition only for skeleton + failed/closed", () => {
    expect(
      shouldFlushOnTransition({ currentTier: "skeleton", toStatus: "failed" as SessionStatus }),
    ).toBe(true);
    expect(
      shouldFlushOnTransition({ currentTier: "skeleton", toStatus: "closed" as SessionStatus }),
    ).toBe(true);
    expect(
      shouldFlushOnTransition({ currentTier: "skeleton", toStatus: "merged" as SessionStatus }),
    ).toBe(false);
    expect(
      shouldFlushOnTransition({ currentTier: "full", toStatus: "failed" as SessionStatus }),
    ).toBe(false);
    expect(
      shouldFlushOnTransition({ currentTier: "skeleton", toStatus: "active" as SessionStatus }),
    ).toBe(false);
  });
});
