// Root tRPC router (seam 1, docs/10 §2). Merges the sub-routers. This is the
// AppRouter the web client is typed by (§5.25 createTRPCReact).

import { router } from "./context";
import { sessionRouter } from "./routers/session";
import { promptRouter } from "./routers/prompt";

export const appRouter = router({
  session: sessionRouter,
  prompt: promptRouter,
});

export type AppRouter = typeof appRouter;
