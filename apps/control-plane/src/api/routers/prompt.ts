// Prompt router (seam 1, docs/10 §2). prompt.submit calls the DO in-process,
// then runs the agent turn (model stream → DO transitions, §5.21–5.22).

import { promptSubmitSchema } from "@forge/domain";
import { authedProcedure, t } from "../context";
import { buildServices, resolveProfile, type Env } from "../../env";
import { runAgentTurn } from "../../agent/loop";

interface SessionDOStub {
  submitPrompt(i: {
    userId: string;
    content: string;
    modelParams?: { model: string; reasoning?: string; temperature?: number };
  }): Promise<{ promptId: string }>;
}

/**
 * Module-level set of in-flight agent turns. Keeps the promises alive so the
 * runtime doesn't GC them before they resolve (there's no ExecutionContext to
 * call waitUntil on from a tRPC procedure). Each turn removes itself on settle.
 * In production (§6+), this would use executionContext.waitUntil instead.
 */
const inFlightTurns = new Set<Promise<void>>();

/**
 * Drain all in-flight agent turns (for tests). Returns when every pending turn
 * has settled or after a 2s timeout (whichever is first). This prevents dangling
 * promises from blocking the Vite server teardown in the test pool. The timeout
 * is necessary because DO RPC promises in the miniflare test pool may not settle
 * cleanly when called fire-and-forget from a router procedure.
 */
export async function drainAgentTurns(): Promise<void> {
  if (inFlightTurns.size === 0) return;
  const timeout = new Promise<void>((r) => setTimeout(r, 2000));
  await Promise.race([Promise.allSettled(Array.from(inFlightTurns)), timeout]);
}

/**
 * Run an agent turn in the background (fire-and-forget with error capture).
 * The prompt response returns immediately; the client observes state changes
 * over the WS (the DO broadcasts on each transition, §5.12).
 */
function runAgentTurnSafe(env: Env, sessionId: string, prompt: string): void {
  const turn = (async () => {
    const services = await buildServices(resolveProfile(env), env);
    await runAgentTurn({ sessionId, prompt, model: services.model, env }).catch(() => {
      // Agent turn failure is non-fatal — the DO stays in its current status.
      // The client observes the failure as a lack of progress / a status change.
    });
  })();
  inFlightTurns.add(turn);
  turn.finally(() => inFlightTurns.delete(turn));
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
    // The turn runs without blocking the HTTP response — the client observes state
    // changes over the WS (the DO broadcasts on each transition). We attach the
    // turn promise to a module-level set so the runtime doesn't GC it before it
    // resolves; errors are caught (a failed turn surfaces as a DO status change).
    void runAgentTurnSafe(ctx.env, input.sessionId, input.content);
    return { promptId };
  }),
});
