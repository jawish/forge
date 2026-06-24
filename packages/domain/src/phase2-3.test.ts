import { describe, expect, it } from "vitest";
import {
  applyContextHygiene,
  compactContext,
  needsCompaction,
  CONTEXT_WINDOW_DEFAULTS,
  type ContextTurn,
} from "./context-hygiene";
import {
  checkpoint,
  createCircuitBreaker,
  isBreakerOpen,
  recordFailure,
  recordSuccess,
  withRetry,
  spawnSubSession,
  MemoryCheckpointStore,
} from "./resilience";
import { createOnboardingPr, generateDockerfile, generateRepoConfig } from "./onboarding";
import {
  evaluateMcpRegistration,
  verifyMcpAtSpawn,
  MemoryMcpRegistryStore,
} from "./mcp-governance";
import {
  orchestrateCrossRepo,
  MemoryKnowledgeStore,
  runSelfImprovement,
  createInPlatformReview,
  addHumanComment,
  transitionReviewState,
} from "./phase3";

// Helper: create a turn with a token count.
function turn(role: ContextTurn["role"], content: string, tokenCount: number): ContextTurn {
  return { role, content, tokenCount, ts: Date.now() };
}

describe("context-hygiene (§9b)", () => {
  const config = {
    maxContextTokens: 1000,
    reserveOutputTokens: 200,
    compactionThreshold: 0.8,
    minRecentTurns: 2,
  };

  it("needsCompaction: false when under threshold", () => {
    const turns = [turn("user", "hello", 100)];
    expect(needsCompaction(turns, config)).toBe(false);
  });

  it("needsCompaction: true when over threshold", () => {
    const turns = [turn("user", "big", 700), turn("assistant", "resp", 200)];
    expect(needsCompaction(turns, config)).toBe(true);
  });

  it("compactContext: summarizes old turns, keeps recent", async () => {
    const turns = [
      turn("user", "old1", 100),
      turn("assistant", "old2", 100),
      turn("user", "recent1", 100),
      turn("assistant", "recent2", 100),
    ];
    const result = await compactContext({
      turns,
      config: { ...config, minRecentTurns: 2 },
      summarize: async (old) => `summary of ${old.length} turns`,
      countTokens: (s) => s.length,
    });
    expect(result).toHaveLength(3); // summary + 2 recent
    expect(result[0].role).toBe("system");
    expect(result[0].content).toContain("summary");
    expect(result[1].content).toBe("recent1");
    expect(result[2].content).toBe("recent2");
  });

  it("applyContextHygiene: no-op when under threshold", async () => {
    const turns = [turn("user", "small", 50)];
    const result = await applyContextHygiene({
      turns,
      config,
      summarize: async () => "summary",
      countTokens: () => 10,
    });
    expect(result).toBe(turns); // unchanged
  });

  it("CONTEXT_WINDOW_DEFAULTS has all 5 tiers", () => {
    expect(Object.keys(CONTEXT_WINDOW_DEFAULTS)).toHaveLength(5);
  });
});

describe("resilience (§9c)", () => {
  it("checkpoint: saves + loads", async () => {
    const store = new MemoryCheckpointStore();
    await checkpoint({ sessionId: "s1", turnNumber: 3, state: { foo: "bar" }, store });
    const loaded = await store.load("s1");
    expect(loaded).toBeTruthy();
    expect(loaded!.turnNumber).toBe(3);
  });

  it("circuit breaker: trips after threshold failures", () => {
    let breaker = createCircuitBreaker("openai", 3);
    expect(isBreakerOpen(breaker)).toBe(false);
    breaker = recordFailure(breaker);
    breaker = recordFailure(breaker);
    expect(isBreakerOpen(breaker)).toBe(false);
    breaker = recordFailure(breaker);
    expect(isBreakerOpen(breaker)).toBe(true);
  });

  it("circuit breaker: resets on success", () => {
    let breaker = createCircuitBreaker("openai", 2);
    breaker = recordFailure(breaker);
    breaker = recordFailure(breaker);
    expect(isBreakerOpen(breaker)).toBe(true);
    breaker = recordSuccess(breaker);
    expect(isBreakerOpen(breaker)).toBe(false);
  });

  it("withRetry: retries on failure then succeeds", async () => {
    let attempts = 0;
    const result = await withRetry({
      operation: async () => {
        attempts++;
        if (attempts < 3) throw new Error("transient");
        return "ok";
      },
      maxRetries: 5,
      baseDelayMs: 1,
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("withRetry: throws after maxRetries", async () => {
    await expect(
      withRetry({
        operation: async () => {
          throw new Error("permanent");
        },
        maxRetries: 2,
        baseDelayMs: 1,
      }),
    ).rejects.toThrow("permanent");
  });

  it("spawnSubSession: creates a child session ref", () => {
    const sub = spawnSubSession({ parentSessionId: "p1", prompt: "explore alt approach" });
    expect(sub.childSessionId).toMatch(/^sess_sub_/);
    expect(sub.parentSessionId).toBe("p1");
    expect(sub.status).toBe("running");
  });
});

describe("onboarding wizard (§9d)", () => {
  it("createOnboardingPr: generates config + Dockerfile + setup.sh, opens PR", async () => {
    let createdFiles: string[] = [];
    const result = await createOnboardingPr({
      repo: "my-org/my-repo",
      input: { language: "python" },
      userId: "u1",
      createPr: async (input) => {
        createdFiles = input.files.map((f) => f.path);
        return { prUrl: "https://github.com/my-org/my-repo/pull/1", prNumber: 1 };
      },
    });
    expect(result.prNumber).toBe(1);
    expect(createdFiles).toContain(".forge/config.toml");
    expect(createdFiles).toContain(".forge/Dockerfile");
    expect(createdFiles).toContain(".forge/setup.sh");
  });

  it("generateDockerfile: uses Chainguard base + ENTRYPOINT reset", () => {
    const dockerfile = generateDockerfile({ language: "python" });
    expect(dockerfile).toContain("chainguard/python");
    expect(dockerfile).toContain("ENTRYPOINT []");
  });

  it("generateRepoConfig: produces valid TOML with all sections", () => {
    const config = generateRepoConfig({ language: "typescript" });
    expect(config).toContain("[build]");
    expect(config).toContain("[model]");
    expect(config).toContain("[paths]");
    expect(config).toContain("[egress]");
    expect(config).toContain("registry.npmjs.org");
  });
});

describe("MCP governance (§9e)", () => {
  it("evaluateMcpRegistration: approves when all checks pass", async () => {
    const verdict = await evaluateMcpRegistration({
      registration: {
        image: "ghcr.io/org/mcp:1.0",
        sourceRepo: "org/mcp",
        manifest: { egress: [], tools: [] },
        publisher: "org",
      },
      scorecard: async () => ({ score: 8.0, findings: [] }),
      trivy: async () => ({ highCount: 2, criticalCount: 0 }),
      cosign: async () => ({ verified: true, digest: "sha256:abc" }),
    });
    expect(verdict.approved).toBe(true);
    expect(verdict.checks).toHaveLength(3);
    expect(verdict.imageDigest).toBe("sha256:abc");
  });

  it("evaluateMcpRegistration: rejects when scorecard too low", async () => {
    const verdict = await evaluateMcpRegistration({
      registration: {
        image: "ghcr.io/org/mcp:1.0",
        sourceRepo: "org/mcp",
        manifest: { egress: [], tools: [] },
        publisher: "org",
      },
      scorecard: async () => ({ score: 3.0, findings: ["no branch protection"] }),
      trivy: async () => ({ highCount: 0, criticalCount: 0 }),
      cosign: async () => ({ verified: true, digest: "sha256:abc" }),
    });
    expect(verdict.approved).toBe(false);
    expect(verdict.rejectionReason).toContain("scorecard");
  });

  it("evaluateMcpRegistration: rejects when critical vulns found", async () => {
    const verdict = await evaluateMcpRegistration({
      registration: {
        image: "ghcr.io/org/mcp:1.0",
        sourceRepo: "org/mcp",
        manifest: { egress: [], tools: [] },
        publisher: "org",
      },
      scorecard: async () => ({ score: 8.0, findings: [] }),
      trivy: async () => ({ highCount: 0, criticalCount: 1 }),
      cosign: async () => ({ verified: true, digest: "sha256:abc" }),
    });
    expect(verdict.approved).toBe(false);
  });

  it("verifyMcpAtSpawn: re-checks cosign on pinned digest", async () => {
    const ok = await verifyMcpAtSpawn({
      image: "ghcr.io/org/mcp",
      pinnedDigest: "sha256:abc",
      publisher: "org",
      cosign: async () => ({ verified: true, digest: "sha256:abc" }),
    });
    expect(ok).toBe(true);
  });

  it("MemoryMcpRegistryStore: add + list + remove", async () => {
    const store = new MemoryMcpRegistryStore();
    await store.add("repo1", {
      image: "ghcr.io/mcp:1",
      digest: "sha:1",
      manifest: { egress: [], tools: [] },
    });
    const list = await store.list("repo1");
    expect(list).toHaveLength(1);
    await store.remove("repo1", "ghcr.io/mcp:1");
    expect(await store.list("repo1")).toHaveLength(0);
  });
});

describe("Phase 3: orchestration + knowledge + self-improvement (§10)", () => {
  it("orchestrateCrossRepo: parallel fan-out", async () => {
    const result = await orchestrateCrossRepo({
      task: {
        parentSessionId: "p1",
        task: "update deps",
        targets: [
          { repoId: "a", branch: "main" },
          { repoId: "b", branch: "main" },
        ],
        parallel: true,
      },
      spawn: async ({ repoId }) => ({
        sessionId: `s_${repoId}`,
        status: "completed" as const,
        prUrl: `https://github.com/${repoId}/pull/1`,
      }),
    });
    expect(result.successCount).toBe(2);
    expect(result.results).toHaveLength(2);
  });

  it("orchestrateCrossRepo: handles partial failure", async () => {
    const result = await orchestrateCrossRepo({
      task: {
        parentSessionId: "p1",
        task: "update deps",
        targets: [
          { repoId: "good", branch: "main" },
          { repoId: "bad", branch: "main" },
        ],
        parallel: true,
      },
      spawn: async ({ repoId }) => {
        if (repoId === "bad") throw new Error("build failed");
        return { sessionId: "s", status: "completed" as const, prUrl: "url" };
      },
    });
    expect(result.successCount).toBe(1);
    expect(result.results.find((r) => r.repoId === "bad")?.status).toBe("failed");
  });

  it("MemoryKnowledgeStore: record + retrieve", async () => {
    const store = new MemoryKnowledgeStore();
    await store.record({
      repoId: "r1",
      insight: "use pnpm not npm",
      category: "convention",
      sessionId: "s1",
    });
    const insights = await store.retrieve({ repoId: "r1", task: "setup" });
    expect(insights).toHaveLength(1);
    expect(insights[0].insight).toContain("pnpm");
  });

  it("runSelfImprovement: extracts + records learnings", async () => {
    const knowledge = new MemoryKnowledgeStore();
    const learning = await runSelfImprovement({
      sessionId: "s1",
      sessionLog: {},
      repoId: "r1",
      analyze: async () => ({
        sessionId: "s1",
        positives: ["good error handling"],
        negatives: ["forgot to add tests"],
        improvements: ["always add tests for new functions"],
      }),
      knowledge,
    });
    expect(learning.positives).toHaveLength(1);
    const insights = await knowledge.retrieve({ repoId: "r1", task: "" });
    expect(insights).toHaveLength(3); // 1 positive + 1 negative + 1 improvement
  });

  it("in-platform review: create + comment + transition", () => {
    let review = createInPlatformReview({
      sessionId: "s1",
      agentComments: [{ category: "security", severity: "warning", message: "sanitize input" }],
    });
    expect(review.state).toBe("pending");
    review = addHumanComment(review, { author: "reviewer1", message: "looks good" });
    expect(review.humanComments).toHaveLength(1);
    review = transitionReviewState(review, "approved");
    expect(review.state).toBe("approved");
  });
});
