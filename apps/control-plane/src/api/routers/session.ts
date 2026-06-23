// Session router (seam 1, docs/10 §2). Procedures call env.SESSION_DO.get(id)
// directly — in-process DO access (seam 2). Inputs are zod from @forge/domain.

import {
  sessionCancelInputSchema,
  sessionCreateInputSchema,
  sessionGetInputSchema,
  type SessionStatus,
} from "@forge/domain";
import { authedProcedure, t } from "../context";

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
    const stub = ctx.env.SESSION_DO.idFromName(input.sessionId);
    const doStub = ctx.env.SESSION_DO.get(stub) as unknown as SessionDOStub;
    return doStub.getStatus();
  }),

  create: authedProcedure.input(sessionCreateInputSchema).mutation(async ({ input, ctx }) => {
    // The DO is addressed by name; we generate a fresh name per session and
    // return it (callers use this name to address the same DO). Do NOT return
    // the DO's internal id (this.ctx.id.toString()) — idFromName(internalId)
    // would create a different DO.
    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const stub = ctx.env.SESSION_DO.idFromName(sessionId);
    const doStub = ctx.env.SESSION_DO.get(stub) as unknown as SessionDOStub;
    await doStub.spawn({
      repoId: input.repoId,
      branch: input.branch,
      createdByUserId: ctx.userId,
      primaryModel: input.primaryModel,
      budgetLimitUsd: input.budgetLimitUsd,
    });
    return { sessionId };
  }),

  cancel: authedProcedure.input(sessionCancelInputSchema).mutation(async ({ input, ctx }) => {
    const stub = ctx.env.SESSION_DO.idFromName(input.sessionId);
    const doStub = ctx.env.SESSION_DO.get(stub) as unknown as SessionDOStub;
    return doStub.cancel(input.reason);
  }),
});
