// Test entry point — imports the fetch handler from handler.ts (NOT index.ts)
// to avoid pulling in the Sandbox DO class export from @cloudflare/sandbox,
// which has transitive deps that break the miniflare test pool.
// At deploy time, wrangler uses src/index.ts (which does export Sandbox).

import { createFetchHandler } from "./handler";

export { SessionDO } from "./handler";

// Stub Sandbox DO class for tests (the real one is only needed at deploy time).
export class Sandbox {
  constructor() {}
  async fetch(): Promise<Response> {
    return new Response("sandbox stub (test mode)", { status: 200 });
  }
}

export default createFetchHandler();
