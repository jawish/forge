// Prompt router (seam 1, docs/10 §2). prompt.submit calls the DO in-process,
// then runs the agent turn (model stream → DO transitions, §5.21–5.22).

import { promptSubmitSchema } from "@forge/domain";
import { authedProcedure, t } from "../context";
import { buildServices, resolveProfile } from "../../env";
import { runAgentTurn } from "../../agent/loop";

interface SessionDOStub {
  submitPrompt(i: {
    userId: string;
    content: string;
    modelParams?: { model: string; reasoning?: string; temperature?: number };
  }): Promise<{ promptId: string }>;
}

/**
 * Module-level set of in-flight agent turns. Used as a fallback when no
 * ExecutionContext is available (tests). In the deployed worker, ctx.waitUntil
 * is the primary mechanism — the set keeps the promise alive in tests.
 */
const inFlightTurns = new Set<Promise<void>>();

/** Drain all in-flight agent turns (for tests). */
export async function drainAgentTurns(): Promise<void> {
  if (inFlightTurns.size === 0) return;
  const timeout = new Promise<void>((r) => setTimeout(r, 2000));
  await Promise.race([Promise.allSettled(Array.from(inFlightTurns)), timeout]);
}

export const promptRouter = t.router({
  submit: authedProcedure.input(promptSubmitSchema).mutation(async ({ input, ctx }) => {
    const stub = ctx.env.SESSION_DO.idFromName(input.sessionId);
    const doStub = ctx.env.SESSION_DO.get(stub) as unknown as SessionDOStub;
    const { promptId } = await doStub.submitPrompt({
      userId: ctx.userId,
      content: input.content,
      modelParams: input.modelParams,
    });

    // Run the agent turn (§5.21–5.22): stream the model, drive DO transitions.
    // Uses ctx.executionCtx.waitUntil so the turn keeps running after the HTTP
    // response returns. Falls back to the inFlightTurns set in tests (no ctx).
    const turn = (async () => {
      try {
        const services = await buildServices(resolveProfile(ctx.env), ctx.env);
        await runAgentTurn({
          sessionId: input.sessionId,
          prompt: input.content,
          model: services.model,
          sandbox: services.sandbox,
          env: ctx.env,
        });
      } catch {
        // Agent turn failure is non-fatal — the DO stays in its current status.
      }
    })();

    if (ctx.executionCtx) {
      // Deployed worker: use ExecutionContext.waitUntil (the correct mechanism).
      ctx.executionCtx.waitUntil(turn);
    } else {
      // Tests: keep the promise alive so it doesn't get GC'd before resolving.
      inFlightTurns.add(turn);
      turn.finally(() => inFlightTurns.delete(turn));
    }

    return { promptId };
  }),
});
