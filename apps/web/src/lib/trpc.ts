// tRPC client — typed by the control-plane AppRouter (docs/10 §2, §5.25).
// createTRPCReact gives end-to-end types; procedures become query keys + mutations.
//
// The AppRouter type is re-exported from the control-plane package so the web
// client's procedure signatures stay in lockstep (no codegen).

import { httpBatchLink, loggerLink } from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@forge/control-plane/router";

// Re-export the AppRouter type for the createTRPCReact generic. The control-plane
// package exports it from src/api/router (workspace import — types only, not the
// runtime router, since the web Worker has no DO bindings).
export type { AppRouter };

export const trpc = createTRPCReact<AppRouter>();

/** The tRPC client config — calls the control-plane Worker at FORGE_CP_ORIGIN. */
export function trpcClient(origin: string) {
  return trpc.createClient({
    links: [loggerLink({ enabled: () => false }), httpBatchLink({ url: `${origin}/api` })],
  });
}
