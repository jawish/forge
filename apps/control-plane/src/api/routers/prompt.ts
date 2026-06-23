// Prompt router (seam 1, docs/10 §2). prompt.submit calls the DO in-process.

import { promptSubmitSchema } from "@forge/domain";
import { authedProcedure, t } from "../context";

interface SessionDOStub {
  submitPrompt(i: {
    userId: string;
    content: string;
    modelParams?: { model: string; reasoning?: string; temperature?: number };
  }): Promise<{ promptId: string }>;
}

export const promptRouter = t.router({
  submit: authedProcedure.input(promptSubmitSchema).mutation(async ({ input, ctx }) => {
    const stub = ctx.env.SESSION_DO.idFromName(input.sessionId);
    const doStub = ctx.env.SESSION_DO.get(stub) as unknown as SessionDOStub;
    return doStub.submitPrompt({
      userId: ctx.userId,
      content: input.content,
      modelParams: input.modelParams,
    });
  }),
});
