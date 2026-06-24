// Miniflare seam-test harness (docs/16 §3, checklist §4.8).
//
// Seam tests run against miniflare: real DO SQLite, emulated D1/R2/KV/Queues.
// The @cloudflare/vitest-pool-workers plugin injects `env` (the bound Env) and
// `SELF` (the Worker fetch) into each test that declares them in its signature.
// This file provides:
//   - getMiniflareBindings(): the Env with the fast profile + stubbed services.
//   - helpers to spawn a SessionDO stub by id.
//
// Mocking convention (docs/16 §1): mocks live at the external boundary only
// (real model, real sandbox). Internal seams are always exercised for real.

import type { Env } from "../src/env";

/**
 * The test Env. Vitest pool-workers resolves bindings from wrangler.jsonc (the
 * `fast` env), so most tests just take `env: Env` in their signature. This
 * helper is for tests that need to construct/mock the Env directly (e.g. to
 * force a profile or inject a fake binding).
 */
export function getMiniflareBindings(overrides: Partial<Env> = {}): Env {
  // The pool injects real miniflare-backed bindings; these defaults mirror the
  // fast-profile shape for direct-construction cases.
  return {
    FORGE_DEV_PROFILE: "fast",
    SESSION_DO: {} as Env["SESSION_DO"],
    DB: {} as D1Database,
    ARTIFACTS: {} as R2Bucket,
    SANDBOXES: {} as R2Bucket,
    AUDIT: {} as R2Bucket,
    CONFIG_KV: {} as KVNamespace,
    WORK_QUEUE: {} as Queue<unknown>,
    ...overrides,
  };
}

/** A deterministic session id for tests. */
export function testSessionId(n = 1): string {
  return `sess_test_${n}`;
}

/** A deterministic correlation id for tests. */
export function testCorrelationId(n = 1): string {
  return `trace_test_${n}`;
}
