// Forge control-plane Worker entry (docs/09 §3, docs/10 §6).
// The fetch handler is extracted to handler.ts so the test entry point
// (test-entry.ts) can import it without pulling in the Sandbox DO class
// (which has transitive deps that break the miniflare test pool).

import { createFetchHandler } from "./handler";

// Export the DO classes so wrangler bindings resolve them at deploy time.
export { SessionDO } from "./handler";
export { Sandbox } from "@cloudflare/sandbox";

export default createFetchHandler();
