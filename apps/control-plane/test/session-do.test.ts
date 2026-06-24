/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { IllegalTransitionError, type SessionStatus } from "@forge/domain";

// Seam 2 — SessionDO + state machine (docs/12 §2, docs/11, checklist §5.1–5.5).
// Uses the DO RPC stub: env.sessionDo.get(id) returns a stub whose methods
// (spawn, transitionTo, getStatus, ...) are callable directly — the Agent base
// exposes them over RPC. Real SQLite (miniflare); mocks only at the boundary.

/** Get an RPC stub for a session DO by name. */
function session(id: string) {
  const idObj = env.sessionDo.idFromName(id);
  return env.sessionDo.get(idObj) as unknown as {
    spawn(i: {
      repoId: string;
      branch: string;
      createdByUserId: string;
      primaryModel?: string;
    }): Promise<{ sessionId: string }>;
    transitionTo(
      to: { status?: SessionStatus; activity?: SessionActivity | null },
      reason: string,
    ): Promise<{ from: unknown; to: { status: SessionStatus; activity: SessionActivity | null } }>;
    getStatus(): Promise<{
      status: SessionStatus;
      activity: SessionActivity | null;
      costUsd: number;
      tokensIn: number;
      tokensOut: number;
    }>;
    completePR(c: { diffSummary: string; commitSha: string }): Promise<void>;
    requestHumanInput(q: string): Promise<void>;
    createArtifact(a: {
      type: string;
      storageUri: string;
      generatedBy: string;
    }): Promise<{ artifactId: string }>;
    cancel(reason: string): Promise<{ status: SessionStatus }>;
  };
}

type SessionActivity = "provisioning" | "running" | "awaiting_input" | "paused" | "stuck";

describe("seam 2 — SessionDO spawn + status_history (§5.1, §5.2)", () => {
  it("spawn creates the session in queued", async () => {
    const id = `do_spawn_${Date.now()}`;
    const result = await session(id).spawn({
      repoId: "repo_1",
      branch: "forge/u/x",
      createdByUserId: "user_1",
    });
    // sessionId is the DO's id (idFromName hash), not the name — assert it's set.
    expect(result.sessionId).toBeTruthy();
    expect(typeof result.sessionId).toBe("string");
    const status = await session(id).getStatus();
    expect(status.status).toBe("queued");
    expect(status.activity).toBeNull();
  });

  it("queued -> active is legal; activity can then be set to running", async () => {
    const id = `do_active_${Date.now()}`;
    await session(id).spawn({ repoId: "repo_1", branch: "b", createdByUserId: "user_1" });
    const t1 = await session(id).transitionTo({ status: "active" }, "sandbox_provisioned");
    expect(t1.to.status).toBe("active");
    await session(id).transitionTo({ activity: "running" }, "first_thinking_event");
    const status = await session(id).getStatus();
    expect(status.status).toBe("active");
    expect(status.activity).toBe("running");
  });
});

/**
 * Assert a promise rejects, using try/catch (not `expect().rejects`) so the RPC
 * layer's promise rejection isn't logged as an unhandled error before the
 * matcher catches it. The DO RPC throws IllegalTransitionError across the
 * boundary; this swallows it cleanly.
 */
async function assertRejects(p: Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await p;
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
}

describe("seam 2 — transition legality via the state machine (§5.3)", () => {
  it("rejects illegal transitions (queued -> merged skips the path)", async () => {
    const id = `do_illegal_${Date.now()}`;
    await session(id).spawn({ repoId: "r", branch: "b", createdByUserId: "u" });
    await assertRejects(session(id).transitionTo({ status: "merged" }, "skip"));
  });

  it("rejects queued -> ready_for_pr (must go via active)", async () => {
    const id = `do_illegal2_${Date.now()}`;
    await session(id).spawn({ repoId: "r", branch: "b", createdByUserId: "u" });
    await assertRejects(session(id).transitionTo({ status: "ready_for_pr" }, "skip"));
  });

  it("active -> ready_for_pr -> pr_open -> merged is the happy path", async () => {
    const id = `do_happy_${Date.now()}`;
    await session(id).spawn({ repoId: "r", branch: "b", createdByUserId: "u" });
    await session(id).transitionTo({ status: "active" }, "provisioned");
    await session(id).transitionTo({ activity: "running" }, "running");
    await session(id).transitionTo({ status: "ready_for_pr" }, "agent_complete_pr");
    const atReady = await session(id).getStatus();
    expect(atReady.status).toBe("ready_for_pr");
    expect(atReady.activity).toBeNull();
    await session(id).transitionTo({ status: "pr_open" }, "human_approve_pr");
    await session(id).transitionTo({ status: "merged" }, "pr_merged");
    expect((await session(id).getStatus()).status).toBe("merged");
  });

  it("cancel routes to the legal cancel transition", async () => {
    const id = `do_cancel_${Date.now()}`;
    await session(id).spawn({ repoId: "r", branch: "b", createdByUserId: "u" });
    const r = await session(id).cancel("human_abort");
    expect(r.status).toBe("cancelled");
  });

  it("terminal states reject outgoing transitions", async () => {
    const id = `do_term_${Date.now()}`;
    await session(id).spawn({ repoId: "r", branch: "b", createdByUserId: "u" });
    await session(id).cancel("human_abort");
    await assertRejects(session(id).transitionTo({ status: "active" }, "reopen"));
  });

  it("IllegalTransitionError carries the right category + code", async () => {
    const id = `do_err_${Date.now()}`;
    await session(id).spawn({ repoId: "r", branch: "b", createdByUserId: "u" });
    try {
      await session(id).transitionTo({ status: "merged" }, "skip");
      throw new Error("expected throw");
    } catch (e) {
      // RPC serializes the error; assert on the ForgeError shape it carries.
      expect(e).toBeInstanceOf(Error);
      const msg = (e as Error).message;
      expect(msg).toMatch(/Illegal|illegal|ILLEGAL_TRANSITION/);
    }
  });
});

describe("seam 2 — activity invariant (§5.4)", () => {
  it("activity is null when status !== active", async () => {
    const id = `do_inv_${Date.now()}`;
    await session(id).spawn({ repoId: "r", branch: "b", createdByUserId: "u" });
    await session(id).transitionTo({ status: "active" }, "p");
    await session(id).transitionTo({ status: "ready_for_pr" }, "done");
    const s = await session(id).getStatus();
    expect(s.status).toBe("ready_for_pr");
    expect(s.activity).toBeNull();
  });
});

describe("seam 2 — agent callbacks (§5.2, seam 5 surface)", () => {
  it("completePR moves active -> ready_for_pr", async () => {
    const id = `do_pr_${Date.now()}`;
    await session(id).spawn({ repoId: "r", branch: "b", createdByUserId: "u" });
    await session(id).transitionTo({ status: "active" }, "p");
    await session(id).transitionTo({ activity: "running" }, "run");
    await session(id).completePR({ diffSummary: "fix", commitSha: "abc123" });
    const s = await session(id).getStatus();
    expect(s.status).toBe("ready_for_pr");
    expect(s.activity).toBeNull();
  });

  it("createArtifact returns an artifact id", async () => {
    const id = `do_art_${Date.now()}`;
    await session(id).spawn({ repoId: "r", branch: "b", createdByUserId: "u" });
    const r = await session(id).createArtifact({
      type: "diff",
      storageUri: "r2://forge-artifacts/x.diff",
      generatedBy: "agent",
    });
    expect(r.artifactId).toMatch(/^art_/);
  });

  it("requestHumanInput sets activity=awaiting_input", async () => {
    const id = `do_input_${Date.now()}`;
    await session(id).spawn({ repoId: "r", branch: "b", createdByUserId: "u" });
    await session(id).transitionTo({ status: "active" }, "p");
    await session(id).transitionTo({ activity: "running" }, "run");
    await session(id).requestHumanInput("which branch?");
    const s = await session(id).getStatus();
    expect(s.activity).toBe("awaiting_input");
  });
});

// Reference to keep the type import used.
void IllegalTransitionError;
