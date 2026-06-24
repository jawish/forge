// Session router (seam 1, docs/10 §2). Procedures call env.sessionDo.get(id)
// directly — in-process DO access (seam 2). Inputs are zod from @forge/domain.

import {
  sessionCancelInputSchema,
  sessionCreateInputSchema,
  sessionGetInputSchema,
  sessionListInputSchema,
  sessionStatsInputSchema,
  type SessionStatus,
} from "@forge/domain";
import { authedProcedure, t } from "../context";
import { ensureD1SessionTable } from "../../do/d1-schema";

/** RPC stub shape for the SessionDO methods this router calls. */
interface SessionDOStub {
  spawn(i: {
    repoId: string;
    branch: string;
    createdByUserId: string;
    primaryModel?: string;
    budgetLimitUsd?: number;
  }): Promise<{ sessionId: string }>;
  getStatus(): Promise<{
    status: SessionStatus;
    activity: string | null;
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
  }>;
  cancel(reason: string): Promise<{ status: SessionStatus }>;
}

export const sessionRouter = t.router({
  get: authedProcedure.input(sessionGetInputSchema).query(async ({ input, ctx }) => {
    const stub = ctx.env.sessionDo.idFromName(input.sessionId);
    const doStub = ctx.env.sessionDo.get(stub) as unknown as SessionDOStub;
    return doStub.getStatus();
  }),
  list: authedProcedure.input(sessionListInputSchema).query(async ({ input, ctx }) => {
    await ensureD1SessionTable(ctx.env.DB);
    // Build the WHERE clause from the optional filters; bind params positionally.
    const where: string[] = [];
    const binds: (string | number)[] = [];
    const userId = input.userId ?? ctx.userId;
    where.push("created_by_user_id = ?");
    binds.push(userId);
    if (input.repoId) {
      where.push("repo_id = ?");
      binds.push(input.repoId);
    }
    if (input.status) {
      where.push("status = ?");
      binds.push(input.status);
    }
    if (input.beforeCreatedAt !== undefined) {
      where.push("created_at < ?");
      binds.push(input.beforeCreatedAt);
    }
    const sql = `SELECT id, repo_id, branch, created_by_user_id, status, activity,
      primary_model, pr_url, pr_number, created_at, ended_at, total_cost_usd,
      total_tokens_in, total_tokens_out, outcome
      FROM session WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC LIMIT ?`;
    binds.push(input.limit);
    const { results } = await ctx.env.DB.prepare(sql)
      .bind(...binds)
      .all();
    return (results as unknown as SessionListRow[]).map(rowToSummary);
  }),

  /**
   * Aggregate session stats (docs/07 §4.4 — conversion funnel + cost/session).
   * Reads from the D1 projection.
   */
  stats: authedProcedure.input(sessionStatsInputSchema).query(async ({ input, ctx }) => {
    await ensureD1SessionTable(ctx.env.DB);
    const where: string[] = [];
    const binds: (string | number)[] = [];
    const userId = input.userId ?? ctx.userId;
    where.push("created_by_user_id = ?");
    binds.push(userId);
    if (input.repoId) {
      where.push("repo_id = ?");
      binds.push(input.repoId);
    }
    if (input.since !== undefined) {
      where.push("created_at >= ?");
      binds.push(input.since);
    }
    const whereClause = where.join(" AND ");
    // Count by status (the funnel breakdown).
    const statusRows = (await ctx.env.DB.prepare(
      `SELECT status, COUNT(*) as n FROM session WHERE ${whereClause} GROUP BY status`,
    )
      .bind(...binds)
      .all()) as { results: { status: string; n: number }[] };
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of statusRows.results ?? []) {
      byStatus[r.status] = r.n;
      total += r.n;
    }
    // Cost rollup.
    const costRow = (await ctx.env.DB.prepare(
      `SELECT
        COALESCE(SUM(total_cost_usd), 0) as total_cost_usd,
        COALESCE(SUM(total_tokens_in), 0) as total_tokens_in,
        COALESCE(SUM(total_tokens_out), 0) as total_tokens_out
       FROM session WHERE ${whereClause}`,
    )
      .bind(...binds)
      .first()) as {
      total_cost_usd: number;
      total_tokens_in: number;
      total_tokens_out: number;
    } | null;
    const totalCostUsd = costRow?.total_cost_usd ?? 0;
    const totalTokensIn = costRow?.total_tokens_in ?? 0;
    const totalTokensOut = costRow?.total_tokens_out ?? 0;
    const mergedCount = byStatus["merged"] ?? 0;
    return {
      total,
      byStatus,
      mergedCount,
      failedCount: byStatus["failed"] ?? 0,
      cancelledCount: byStatus["cancelled"] ?? 0,
      totalCostUsd,
      totalTokensIn,
      totalTokensOut,
      mergeRate: total > 0 ? mergedCount / total : 0,
      avgCostPerSession: total > 0 ? totalCostUsd / total : 0,
    };
  }),

  create: authedProcedure.input(sessionCreateInputSchema).mutation(async ({ input, ctx }) => {
    // The DO is addressed by name; we generate a fresh name per session and
    // return it (callers use this name to address the same DO). Do NOT return
    // the DO's internal id (this.ctx.id.toString()) — idFromName(internalId)
    // would create a different DO.
    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const stub = ctx.env.sessionDo.idFromName(sessionId);
    const doStub = ctx.env.sessionDo.get(stub) as unknown as SessionDOStub;
    await doStub.spawn({
      repoId: input.repoId,
      branch: input.branch,
      createdByUserId: ctx.userId,
      primaryModel: input.primaryModel,
      budgetLimitUsd: input.budgetLimitUsd,
    });
    // Project to D1 (docs/12 §3 — one-way DO→D1 index). The router owns the
    // projection so it writes to the same D1 binding the queries read from
    // (DOs run in a separate isolate with their own bindings in miniflare).
    await ensureD1SessionTable(ctx.env.DB);
    const now = Date.now();
    await ctx.env.DB.prepare(
      `INSERT OR REPLACE INTO session
        (id, repo_id, branch, created_by_user_id, parent_session_id, root_session_id,
         status, activity, primary_model, created_at, ended_at, merged_at,
         total_cost_usd, total_tokens_in, total_tokens_out, outcome)
       VALUES (?, ?, ?, ?, NULL, ?, 'queued', NULL, ?, ?, NULL, NULL, 0, 0, 0, NULL)`,
    )
      .bind(
        sessionId,
        input.repoId,
        input.branch,
        ctx.userId,
        sessionId,
        input.primaryModel ?? null,
        now,
      )
      .run();
    return { sessionId };
  }),

  cancel: authedProcedure.input(sessionCancelInputSchema).mutation(async ({ input, ctx }) => {
    const stub = ctx.env.sessionDo.idFromName(input.sessionId);
    const doStub = ctx.env.sessionDo.get(stub) as unknown as SessionDOStub;
    const result = await doStub.cancel(input.reason);
    // Update the D1 projection to reflect the terminal status.
    await ensureD1SessionTable(ctx.env.DB);
    await ctx.env.DB.prepare(
      `UPDATE session SET status = ?, ended_at = ?, outcome = ? WHERE id = ?`,
    )
      .bind(result.status, Date.now(), result.status, input.sessionId)
      .run();
    return result;
  }),
});

// --- D1 row → SessionSummary mapping (snake_case DB → camelCase API) --------

/** Raw D1 row shape (docs/12 §3 session table column names). */
interface SessionListRow {
  id: string;
  repo_id: string;
  branch: string;
  created_by_user_id: string;
  status: string;
  activity: string | null;
  primary_model: string | null;
  pr_url: string | null;
  pr_number: number | null;
  created_at: number;
  ended_at: number | null;
  total_cost_usd: number;
  total_tokens_in: number;
  total_tokens_out: number;
  outcome: string | null;
}

function rowToSummary(row: SessionListRow) {
  return {
    id: row.id,
    repoId: row.repo_id,
    branch: row.branch,
    createdByUserId: row.created_by_user_id,
    status: row.status,
    activity: row.activity,
    primaryModel: row.primary_model,
    prUrl: row.pr_url,
    prNumber: row.pr_number,
    createdAt: row.created_at,
    endedAt: row.ended_at,
    totalCostUsd: row.total_cost_usd,
    totalTokensIn: row.total_tokens_in,
    totalTokensOut: row.total_tokens_out,
    outcome: row.outcome,
  };
}
