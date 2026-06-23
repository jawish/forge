/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { getMiniflareBindings } from "./helpers";

// Seam 6 (ops/debugging, docs/10 §7) — the /api/ops/health endpoint.
// This is the §4.7 validation criterion in test form: the worker boots,
// /api/ops/health returns 200, and the fast profile is active (zero creds).
//
// `exports.default` is the main Worker's default export (the fetch handler),
// run in the same isolate as tests. The deprecated `SELF` alias was removed;
// use `exports.default.fetch()` per the pool-workers types.

describe("seam 6 — /api/ops/health (checklist §4.7)", () => {
  it("returns 200 with status ok", async () => {
    const res = await exports.default.fetch("http://x/api/ops/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("reports the fast profile + mock model + local sandbox (zero creds)", async () => {
    const res = await exports.default.fetch("http://x/api/ops/health");
    const body = (await res.json()) as { profile: string; model: string; sandbox: string };
    expect(body.profile).toBe("fast");
    expect(body.model).toBe("mock");
    expect(body.sandbox).toBe("local");
  });

  it("env is the fast-profile Env shape", () => {
    expect(env.FORGE_DEV_PROFILE).toBe("fast");
    expect(env.SESSION_DO).toBeDefined();
    expect(env.DB).toBeDefined();
    expect(env.ARTIFACTS).toBeDefined();
    expect(env.AUDIT).toBeDefined();
    expect(env.CONFIG_KV).toBeDefined();
  });

  it("getMiniflareBindings returns the fast-profile Env shape", () => {
    const e = getMiniflareBindings();
    expect(e.FORGE_DEV_PROFILE).toBe("fast");
    expect(e.SESSION_DO).toBeDefined();
  });

  it("unknown paths return 404 (routes not yet wired land in §5/§8)", async () => {
    const res = await exports.default.fetch("http://x/api/nope");
    expect(res.status).toBe(404);
  });
});
