// Profile switch + env bindings (docs/09 §5, checklist §4.5).
// FORGE_DEV_PROFILE selects the provider/model/otel wiring:
//   fast — MockModelProvider + LocalSandboxProvider + console OTel (zero creds)
//   real — AiGatewayModelClient + CloudflareSandboxProvider + console + local CH (§6)
//
// Providers that use node-only APIs (child_process) are loaded lazily so the
// Worker module graph doesn't statically pull them at boot — the deployed Worker
// talks to CF Sandbox over HTTP (§6.3), and only the local fast profile spawns
// subprocesses. Lazy import keeps `wrangler dev` + the test pool booting.

import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { SandboxProvider } from "./sandbox/provider";
import type { ModelProvider } from "./model/provider";

/** The two dev profiles (docs/09 §5). */
export type DevProfile = "fast" | "real";

/** The control-plane Worker bindings (docs/09 §3, wrangler.jsonc). */
export interface Env {
  // Profile selection (vars.FORGE_DEV_PROFILE).
  FORGE_DEV_PROFILE: string;
  // Durable Object: per-session hot state (docs/12 §2).
  SESSION_DO: DurableObjectNamespace;
  // D1: control-plane OLTP index (docs/12 §3).
  DB: D1Database;
  // R2: blobs + WORM audit (docs/12 §4).
  ARTIFACTS: R2Bucket;
  SANDBOXES: R2Bucket;
  AUDIT: R2Bucket;
  // KV: config cache + flags (docs/12 §6).
  CONFIG_KV: KVNamespace;
  // Queues: async work (docs/12 — image builds, analytics pipeline).
  WORK_QUEUE: Queue<unknown>;
  // Slack (§8.1): signing secret + bot token. Bound from CF Secrets Store; the
  // fast profile runs without them (the ports factory logs instead of posting).
  SLACK_SIGNING_SECRET?: string;
  SLACK_BOT_TOKEN?: string;
  // Workers AI + Vectorize (§8.1 stage-2 router). Bound when provisioned; the
  // fast profile uses deterministic stubs.
  AI?: Ai;
  VECTORIZE?: VectorizeIndex;
}

/**
 * Resolve the active dev profile from the env var. Defaults to fast (zero-cred).
 */
export function resolveProfile(env: Pick<Env, "FORGE_DEV_PROFILE">): DevProfile {
  return env.FORGE_DEV_PROFILE === "real" ? "real" : "fast";
}

/** Runtime services resolved from the profile. Built once per request/DO. */
export interface ProfileServices {
  profile: DevProfile;
  sandbox: SandboxProvider;
  model: ModelProvider;
}

// Module-level singletons: the providers are built once (cheap; the LocalSandbox
// provider just holds Maps). Lazy import isolates node-only modules from the
// worker's static graph.
let cachedServices: ProfileServices | null = null;

/**
 * Build (and cache) the profile's runtime services. In fast: mocks. In real:
 * real impls (§6). The lazy import keeps node-only modules out of the worker
 * boot graph — the fast profile's LocalSandboxProvider uses child_process, which
// only the local `wrangler dev` workerd (and the node test pool) can load.
 */
export async function buildServices(profile: DevProfile): Promise<ProfileServices> {
  if (cachedServices) return cachedServices;
  if (profile === "real") {
    // §6 replaces these with the real AI Gateway + CF Sandbox clients.
    // Phase 0 §4–§5 build against fast; real falls back to the same mocks so the
    // loop is runnable without creds. §6 swaps these to real impls.
    const [{ LocalSandboxProvider }, { MockModelProvider }] = await Promise.all([
      import("./sandbox/local-provider"),
      import("./model/mock-provider"),
    ]);
    cachedServices = {
      profile: "real",
      sandbox: new LocalSandboxProvider(),
      model: new MockModelProvider(),
    };
  } else {
    const [{ LocalSandboxProvider }, { MockModelProvider }] = await Promise.all([
      import("./sandbox/local-provider"),
      import("./model/mock-provider"),
    ]);
    cachedServices = {
      profile: "fast",
      sandbox: new LocalSandboxProvider(),
      model: new MockModelProvider(),
    };
  }
  return cachedServices;
}
