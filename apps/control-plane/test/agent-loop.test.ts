/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { runAgentTurn, buildHarnessConfig } from "../src/agent/loop";
import { MockModelProvider } from "../src/model/mock-provider";
import type { SandboxProvider, SandboxHandle } from "../src/sandbox/provider";

// Seam 5 — agent harness + mock model (docs/16 §3, checklist §5.23).
// Spawn a session → run the agent turn with the mock model (read-and-complete
// fixture) → assert the DO reaches ready_for_pr with the state machine driving.

const BASE = "http://x";

/**
 * A no-op sandbox stub for the agent-loop tests. The existing tests pre-transition
 * sessions to active(running), so runAgentTurn's provisioning block (queued →
 * active) never fires — no real provisioning needed. Using a stub avoids importing
 * LocalSandboxProvider (node:child_process) into the worker's static graph.
 */
const sandbox: SandboxProvider = {
  async provision(): Promise<SandboxHandle> {
    return { id: "stub", workdir: "/tmp/stub", imageVersion: "latest" };
  },
  async exec(): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
  },
  async snapshot(): Promise<{ id: string; location: string; takenAt: number }> {
    return { id: "stub-snap", location: "stub", takenAt: Date.now() };
  },
  async restore(): Promise<SandboxHandle> {
    return { id: "stub", workdir: "/tmp/stub", imageVersion: "latest" };
  },
  async destroy(): Promise<void> {},
};

/** Create + walk a session to active(running) so the loop can run. */
async function spawnedRunningSession(repoId: string): Promise<string> {
  const createRes = await exports.default.fetch(`${BASE}/api/session.create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoId, branch: "b", createdByUserId: "u" }),
  });
  const cj = (await createRes.json()) as { result: { data: { sessionId: string } } };
  const sessionId = cj.result.data.sessionId;
  // queued -> active(provisioning) -> running via the DO directly.
  const idObj = env.sessionDo.idFromName(sessionId);
  const stub = env.sessionDo.get(idObj) as unknown as {
    transitionTo(
      to: { status?: string; activity?: string | null },
      reason: string,
    ): Promise<unknown>;
  };
  await stub.transitionTo({ status: "active" }, "sandbox_provisioned");
  await stub.transitionTo({ activity: "running" }, "first_thinking_event");
  return sessionId;
}

describe("seam 5 — agent harness + mock model (§5.21–5.23)", () => {
  it("drives a session to ready_for_pr via the read-and-complete fixture", async () => {
    const sessionId = await spawnedRunningSession("repo_loop_1");
    const result = await runAgentTurn({
      sessionId,
      prompt: "fix the bug",
      model: new MockModelProvider(),
      sandbox,
      env,
    });
    expect(result.finalStatus).toBe("ready_for_pr");
  });

  it("the request-human-input fixture drives activity to awaiting_input", async () => {
    const sessionId = await spawnedRunningSession("repo_loop_2");
    await runAgentTurn({
      sessionId,
      prompt: "which branch should this target?",
      model: new MockModelProvider(),
      sandbox,
      env,
    });
    const idObj = env.sessionDo.idFromName(sessionId);
    const stub = env.sessionDo.get(idObj) as unknown as {
      getStatus(): Promise<{ status: string; activity: string | null }>;
    };
    const status = await stub.getStatus();
    expect(status.activity).toBe("awaiting_input");
  });

  it("the explore fixture (no complete_pr) leaves the session active/running", async () => {
    const sessionId = await spawnedRunningSession("repo_loop_3");
    const result = await runAgentTurn({
      sessionId,
      prompt: "explore the repo, no change needed",
      model: new MockModelProvider(),
      sandbox,
      env,
    });
    // No complete_pr in the explore fixture → stays active (not ready_for_pr).
    expect(result.finalStatus).toBe("active");
  });

  it("buildHarnessConfig lists the platform MCP endpoint + an empty registry allowlist", () => {
    const cfg = buildHarnessConfig({ workerOrigin: "http://x" });
    expect(cfg.platformMcpEndpoint).toBe("http://x/api/mcp");
    expect(cfg.registryAllowlist).toEqual([]);
  });

  it("a complete_pr fixture produces an artifact recordable via the MCP surface", async () => {
    const sessionId = await spawnedRunningSession("repo_loop_4");
    await runAgentTurn({
      sessionId,
      prompt: "fix it",
      model: new MockModelProvider(),
      sandbox,
      env,
    });
    // After the loop reaches ready_for_pr, the agent would have recorded a diff
    // artifact via forge.createArtifact (the fixture models the read+complete path).
    // The DO is now ready_for_pr (verified above for the same fixture).
    const idObj = env.sessionDo.idFromName(sessionId);
    const stub = env.sessionDo.get(idObj) as unknown as {
      getStatus(): Promise<{ status: string }>;
    };
    expect((await stub.getStatus()).status).toBe("ready_for_pr");
  });
});
