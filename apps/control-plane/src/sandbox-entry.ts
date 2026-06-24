// Sandbox DO class re-export — wrangler resolves the Sandbox DO binding from
// this file. Kept separate from index.ts so the main worker bundle (and its
// test entry point) don't pull in @cloudflare/sandbox's transitive deps that
// break the miniflare test pool.
export { Sandbox } from "@cloudflare/sandbox";
