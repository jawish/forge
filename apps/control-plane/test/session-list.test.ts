/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";

// Seam 1 — session.list + session.stats (docs/07 §4.4, docs/12 §3 D1 projection).
// Drives the procedures over real HTTP against the real DO + miniflare-emulated D1.
// Verifies: create projects to D1, cancel updates the projection, list paginates,
// stats computes the conversion funnel + cost rollup.
//
// The D1 session table is created lazily by the router (ensureD1SessionTable).
// Sessions are owned by ctx.userId (user_dev_fast in the fast profile); the list
// query defaults to that same caller, so no userId filter is passed.

const BASE = "http://x";

async function mutate(path: string, body: unknown): Promise<unknown> {
  const res = await exports.default.fetch(`${BASE}/api/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { result?: { data?: unknown }; error?: unknown };
  if (json.error) throw new Error(`tRPC error on ${path}: ${JSON.stringify(json.error)}`);
  return json.result?.data;
}

async function query(path: string, input: unknown): Promise<unknown> {
  const encoded = encodeURIComponent(JSON.stringify(input));
  const res = await exports.default.fetch(`${BASE}/api/${path}?input=${encoded}`);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { result?: { data?: unknown }; error?: unknown };
  if (json.error) throw new Error(`tRPC error on ${path}: ${JSON.stringify(json.error)}`);
  return json.result?.data;
}

/** Create a session owned by the fast-profile dev user (user_dev_fast). */
async function createSession(repoId: string): Promise<string> {
  const created = (await mutate("session.create", {
    repoId,
    branch: "forge/u/x",
    createdByUserId: "user_dev_fast",
  })) as { sessionId: string };
  return created.sessionId;
}

describe("seam 1 — D1 session projection (docs/12 §3, §4.4)", () => {
  it("create projects the session to D1 (session.list returns it)", async () => {
    const id = await createSession("repo_list_spawn");
    // No userId → defaults to ctx.userId (user_dev_fast), the session's owner.
    const list = (await query("session.list", {})) as Array<{
      id: string;
      repoId: string;
      status: string;
    }>;
    const found = list.find((s) => s.id === id);
    expect(found).toBeTruthy();
    expect(found?.repoId).toBe("repo_list_spawn");
    expect(found?.status).toBe("queued");
  });

  it("session.cancel updates the D1 projection status to cancelled", async () => {
    const id = await createSession("repo_list_cancel");
    await mutate("session.cancel", { sessionId: id });
    const list = (await query("session.list", { status: "cancelled" })) as Array<{
      id: string;
      status: string;
      outcome: string | null;
    }>;
    const found = list.find((s) => s.id === id);
    expect(found).toBeTruthy();
    expect(found?.status).toBe("cancelled");
    expect(found?.outcome).toBe("cancelled");
  });

  it("session.list filters by repoId", async () => {
    await createSession("repo_filter_a");
    await createSession("repo_filter_b");
    const listA = (await query("session.list", {
      repoId: "repo_filter_a",
    })) as Array<{ repoId: string }>;
    expect(listA.length).toBeGreaterThan(0);
    expect(listA.every((s) => s.repoId === "repo_filter_a")).toBe(true);
  });

  it("session.list orders by created_at DESC and respects limit", async () => {
    for (let i = 0; i < 3; i++) {
      await createSession("repo_order");
    }
    const list = (await query("session.list", {
      repoId: "repo_order",
      limit: 2,
    })) as Array<{ id: string; createdAt: number }>;
    expect(list.length).toBe(2);
    // DESC: the most-recently-created should be first.
    expect(list[0].createdAt).toBeGreaterThanOrEqual(list[1].createdAt);
  });

  it("session.stats computes total + byStatus + mergeRate", async () => {
    // Create + cancel one to get a known terminal state.
    const id = await createSession("repo_stats");
    await mutate("session.cancel", { sessionId: id });
    const stats = (await query("session.stats", {
      repoId: "repo_stats",
    })) as {
      total: number;
      byStatus: Record<string, number>;
      cancelledCount: number;
      mergeRate: number;
      avgCostPerSession: number;
    };
    expect(stats.total).toBeGreaterThanOrEqual(1);
    expect(stats.byStatus["cancelled"]).toBeGreaterThanOrEqual(1);
    expect(stats.cancelledCount).toBeGreaterThanOrEqual(1);
    expect(stats.mergeRate).toBe(0); // none merged
    expect(stats.avgCostPerSession).toBeGreaterThanOrEqual(0);
  });
});
