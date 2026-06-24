import { describe, expect, it } from "vitest";
import {
  composePrBody,
  forgeBranchName,
  isPrApprovalSatisfied,
  sessionIdFromBranch,
  slugify,
  webhookToTransition,
  type PullRequestWebhook,
} from "./pr";

// Git & PR (docs/04 §6, docs/11 §4, checklist §8.3). Pure-logic unit tests.

describe("forgeBranchName — forge/<user>/<shortid>-<slug> (docs/04 §6)", () => {
  it("builds the canonical branch name", () => {
    expect(
      forgeBranchName({
        user: "jawish",
        sessionId: "sess_abc12345_xyz",
        slug: "Fix checkout total",
      }),
    ).toBe("forge/jawish/abc12345-fix-checkout-total");
  });
  it("truncates a long slug", () => {
    const long = forgeBranchName({
      user: "u",
      sessionId: "sess_shortid",
      slug: "a".repeat(100),
    });
    expect(long.split("-").pop()!.length).toBeLessThanOrEqual(40);
  });
});

describe("slugify", () => {
  it("lowercases + kebab-cases + trims", () => {
    expect(slugify("  Fix the Bug!!! (v2)  ")).toBe("fix-the-bug-v2");
  });
  it("collapses runs of non-alphanumeric", () => {
    expect(slugify("a___b///c")).toBe("a-b-c");
  });
});

describe("composePrBody — session + summary + artifacts + co-author (docs/04 §6)", () => {
  it("includes the session replay link", () => {
    const body = composePrBody({
      sessionLink: "https://forge.internal.example.com/sessions/sess_1",
      summary: "Fixed the checkout total bug",
      artifacts: [],
      userGithub: "jawish",
    });
    expect(body).toContain("https://forge.internal.example.com/sessions/sess_1");
    expect(body).toContain("Fixed the checkout total bug");
  });
  it("lists verification artifacts", () => {
    const body = composePrBody({
      sessionLink: "l",
      summary: "s",
      artifacts: [
        { label: "Test results", uri: "r2://forge-artifacts/tests.json" },
        { label: "Screenshot", uri: "r2://forge-artifacts/shot.png" },
      ],
      userGithub: "u",
    });
    expect(body).toContain("[Test results](r2://forge-artifacts/tests.json)");
    expect(body).toContain("[Screenshot](r2://forge-artifacts/shot.png)");
  });
  it("carries the Co-authored-by trailers (human + Forge Agent)", () => {
    const body = composePrBody({
      sessionLink: "l",
      summary: "s",
      artifacts: [],
      userGithub: "jawish",
    });
    expect(body).toContain("Co-authored-by: jawish <jawish@users.noreply.github.com>");
    expect(body).toContain("Co-authored-by: Forge Agent <forge@noreply.example.com>");
  });
  it("states the human-review + CI gate", () => {
    const body = composePrBody({
      sessionLink: "l",
      summary: "s",
      artifacts: [],
      userGithub: "u",
    });
    expect(body).toMatch(/human review|branch protection/i);
  });
});

describe("isPrApprovalSatisfied — the always-on approval gate (docs/11 §6)", () => {
  it("is satisfied only by a real-user approval", () => {
    expect(isPrApprovalSatisfied({ approved: true, approverUserId: "user_1" })).toBe(true);
  });
  it("rejects unapproved", () => {
    expect(isPrApprovalSatisfied({ approved: false, approverUserId: null })).toBe(false);
  });
  it("rejects approval without an approver (no auto-approve)", () => {
    expect(isPrApprovalSatisfied({ approved: true, approverUserId: null })).toBe(false);
  });
});

describe("webhookToTransition — PR merged/closed → terminal (docs/11 §4)", () => {
  it("a merged PR → merged", () => {
    const w: PullRequestWebhook = {
      action: "closed",
      pull_request: { number: 42, html_url: "u", merged: true, head_ref: "forge/u/abc-fix" },
    };
    expect(webhookToTransition(w)).toEqual({ status: "merged", reason: "pr_merged" });
  });
  it("a closed-without-merge PR → closed", () => {
    const w: PullRequestWebhook = {
      action: "closed",
      pull_request: { number: 42, html_url: "u", merged: false, head_ref: "forge/u/abc-fix" },
    };
    expect(webhookToTransition(w)).toEqual({ status: "closed", reason: "pr_closed" });
  });
  it("opened/reopened → no terminal transition", () => {
    const w: PullRequestWebhook = {
      action: "opened",
      pull_request: { number: 42, html_url: "u", merged: false, head_ref: "forge/u/abc-fix" },
    };
    expect(webhookToTransition(w).status).toBeNull();
  });
});

describe("sessionIdFromBranch — bidirectional PR↔session link (docs/11)", () => {
  it("extracts the shortid from a forge branch", () => {
    expect(sessionIdFromBranch("forge/jawish/abc12345-fix-checkout")).toBe("abc12345");
  });
  it("returns null for a non-forge branch", () => {
    expect(sessionIdFromBranch("feature/foo")).toBeNull();
  });
});
