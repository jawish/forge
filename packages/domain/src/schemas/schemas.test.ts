import { describe, expect, it } from "vitest";
import {
  artifactSchema,
  modelParamsSchema,
  promptSchema,
  promptSubmitSchema,
  repoSchema,
  sessionCancelInputSchema,
  sessionCreateInputSchema,
  sessionSchema,
  sessionStatusSchema,
  toolCallSchema,
} from "../index";

// Golden samples: valid full objects for each schema, derived from docs/12 §2.
const validSession = {
  id: "sess_001",
  repoId: "repo_xyz",
  branch: "forge/alice/abc-fix-typo",
  createdByUserId: "user_123",
  parentSessionId: null,
  rootSessionId: "sess_001",
  status: "active",
  activity: "running",
  primaryModel: "claude-sonnet-4-6",
  sandboxImageVersion: null,
  sandboxId: "sbx_77",
  prUrl: null,
  prNumber: null,
  createdAt: 1719100000000,
  endedAt: null,
  mergedAt: null,
  totalCostUsd: 0.042,
  totalTokensIn: 12000,
  totalTokensOut: 8000,
  budgetLimitUsd: 5.0,
  outcome: null,
  failureReason: null,
};

describe("schemas — session (docs/12 §2)", () => {
  it("accepts a valid full session", () => {
    expect(() => sessionSchema.parse(validSession)).not.toThrow();
  });

  it("rejects an unknown status", () => {
    expect(() => sessionSchema.parse({ ...validSession, status: "paused" })).toThrow();
  });

  it("rejects negative cost", () => {
    expect(() => sessionSchema.parse({ ...validSession, totalCostUsd: -1 })).toThrow();
  });

  it("rejects a non-int prNumber", () => {
    expect(() => sessionSchema.parse({ ...validSession, prNumber: 1.5 })).toThrow();
  });
});

describe("schemas — status enum (9 values, docs/11 §2)", () => {
  it("accepts all 9 statuses", () => {
    for (const s of [
      "queued",
      "active",
      "ready_for_pr",
      "pr_open",
      "merged",
      "closed",
      "no_change",
      "failed",
      "cancelled",
    ]) {
      expect(sessionStatusSchema.parse(s)).toBe(s);
    }
  });
  it("rejects unknown", () => {
    expect(() => sessionStatusSchema.parse("done")).toThrow();
  });
});

describe("schemas — prompt (docs/12 §2)", () => {
  const valid = {
    id: "p_1",
    ts: 1719100000000,
    userId: "user_1",
    promptType: "user",
    content: "fix the typo",
    modelParamsJson: '{"model":"claude-sonnet-4-6"}',
    tokensIn: 100,
    tokensOut: 50,
    contextSnapshotJson: null,
  };
  it("accepts valid", () => expect(() => promptSchema.parse(valid)).not.toThrow());
  it("rejects bad promptType", () =>
    expect(() => promptSchema.parse({ ...valid, promptType: "bot" })).toThrow());
  it("allows null userId (system/agent-internal)", () =>
    expect(() =>
      promptSchema.parse({ ...valid, userId: null, promptType: "system" }),
    ).not.toThrow());
});

describe("schemas — toolCall (docs/12 §2)", () => {
  const valid = {
    id: "tc_1",
    promptId: "p_1",
    ts: 1719100000000,
    toolName: "rg",
    argsJson: '{"pattern":"foo"}',
    resultJson: null,
    errorDetailsJson: null,
    status: "success",
    durationMs: 12,
    exitCode: 0,
    retryCount: 0,
    tokensIn: null,
    tokensOut: null,
  };
  it("accepts valid", () => expect(() => toolCallSchema.parse(valid)).not.toThrow());
  it("rejects negative retryCount", () =>
    expect(() => toolCallSchema.parse({ ...valid, retryCount: -1 })).toThrow());
  it("rejects bad status", () =>
    expect(() => toolCallSchema.parse({ ...valid, status: "pending" })).toThrow());
});

describe("schemas — artifact (docs/12 §2)", () => {
  const valid = {
    id: "art_1",
    ts: 1719100000000,
    type: "diff",
    storageUri: "r2://forge-artifacts/art_1.diff",
    generatedBy: "agent",
    mimeType: "text/plain",
    sizeBytes: 402,
    metadataJson: null,
  };
  it("accepts valid", () => expect(() => artifactSchema.parse(valid)).not.toThrow());
  it("rejects bad type", () =>
    expect(() => artifactSchema.parse({ ...valid, type: "movie" })).toThrow());
  it("rejects bad generatedBy", () =>
    expect(() => artifactSchema.parse({ ...valid, generatedBy: "tool" })).toThrow());
});

describe("schemas — repo (docs/12 §3)", () => {
  const valid = {
    id: "repo_xyz",
    githubOrg: "mycompany",
    githubRepo: "monolith",
    defaultBranch: "main",
    imageConfigJson: "{}",
    tuningJson: "{}",
    onboardingStatus: "ready",
    createdAt: 1719100000000,
    updatedAt: 1719100000000,
  };
  it("accepts valid", () => expect(() => repoSchema.parse(valid)).not.toThrow());
  it("rejects bad onboardingStatus", () =>
    expect(() => repoSchema.parse({ ...valid, onboardingStatus: "new" })).toThrow());
});

describe("schemas — input contracts (docs/10 §2, tRPC procedure inputs)", () => {
  it("sessionCreateInput accepts the spawn shape", () => {
    expect(() =>
      sessionCreateInputSchema.parse({
        repoId: "repo_xyz",
        branch: "forge/u/abc",
        createdByUserId: "user_1",
      }),
    ).not.toThrow();
    expect(
      () => sessionCreateInputSchema.parse({ repoId: "repo_xyz", branch: "b" }), // missing user
    ).toThrow();
  });

  it("sessionCancelInput defaults reason", () => {
    const out = sessionCancelInputSchema.parse({ sessionId: "s1" });
    expect(out.reason).toBe("human_abort");
  });

  it("promptSubmit requires content + userId + sessionId", () => {
    expect(() =>
      promptSubmitSchema.parse({ sessionId: "s1", userId: "u1", content: "do it" }),
    ).not.toThrow();
    expect(() =>
      promptSubmitSchema.parse({ sessionId: "s1", userId: "u1", content: "" }),
    ).toThrow();
  });

  it("modelParams requires a model", () => {
    expect(() => modelParamsSchema.parse({ model: "claude-sonnet-4-6" })).not.toThrow();
    expect(() => modelParamsSchema.parse({ reasoning: "high" })).toThrow();
  });
});
