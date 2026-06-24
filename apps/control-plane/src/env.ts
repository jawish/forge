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
  // Dev-only: bypass CF Access JWT check for API testing. NEVER set in prod.
  FORGE_DEV_BYPASS_AUTH?: string;
  // The worker's own origin (for the agent harness MCP endpoint, §5.20).
  // Set via wrangler vars; defaults to http://localhost:8787 in local dev.
  WORKER_ORIGIN?: string;
  // The sandbox DO namespace (Container-backed, for the real profile, §6.3).
  SANDBOX_DO?: DurableObjectNamespace;
  // Browser Rendering binding (for frontend repo screenshots, §8.2).
  BROWSER?: Fetcher;
  // Durable Object: per-session hot state (docs/12 §2).
  sessionDo: DurableObjectNamespace;
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
  // Real-profile dev-shared creds (§6.1). Bound from CF Secrets Store; absent in
  // fast (the loop falls back to mocks pre-provisioning).
  AI_GATEWAY_ENDPOINT?: string;
  AI_GATEWAY_KEY?: string;
  AI_GATEWAY_PROVIDER?: string;
  AI_GATEWAY_MODEL?: string;
  SANDBOX_ACCOUNT_ID?: string;
  SANDBOX_API_TOKEN?: string;
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
 * Build (and cache) the profile's runtime services. In fast: mocks. In real: real
 * impls (§6) when creds are bound; falls back to mocks if creds are absent (so
 * the loop is runnable without provisioning). Lazy import keeps node-only modules
 * out of the worker boot graph — LocalSandboxProvider uses child_process, which
 * only the local `wrangler dev` workerd (and the node test pool) can load.
 */
export async function buildServices(profile: DevProfile, env?: Env): Promise<ProfileServices> {
  if (cachedServices) return cachedServices;
  if (profile === "real" && env) {
    // Real profile (§6): use CloudflareSandboxProvider + AiGatewayModelProvider
    // when the dev-shared creds are bound. Fall back to mocks if absent so the
    // loop is runnable pre-provisioning (§6.7 validation needs the real creds).
    const useRealSandbox = Boolean(env.SANDBOX_ACCOUNT_ID && env.SANDBOX_API_TOKEN);
    const useRealModel = Boolean(env.AI_GATEWAY_ENDPOINT && env.AI_GATEWAY_KEY);
    const [localMod, mockMod, cfMod, gwMod] = await Promise.all([
      import("./sandbox/local-provider"),
      import("./model/mock-provider"),
      useRealSandbox ? import("./sandbox/cloudflare-provider") : Promise.resolve(null),
      useRealModel ? import("./model/ai-gateway-provider") : Promise.resolve(null),
    ]);
    cachedServices = {
      profile: "real",
      sandbox:
        cfMod && useRealSandbox && env.SANDBOX_DO
          ? new cfMod.CloudflareSandboxProvider(
              {
                accountId: env.SANDBOX_ACCOUNT_ID!,
                apiToken: env.SANDBOX_API_TOKEN!,
              },
              env.SANDBOX_DO,
            )
          : new localMod.LocalSandboxProvider(),
      model:
        gwMod && useRealModel
          ? new gwMod.AiGatewayModelProvider({
              endpoint: env.AI_GATEWAY_ENDPOINT!,
              apiKey: env.AI_GATEWAY_KEY!,
              provider: env.AI_GATEWAY_PROVIDER ?? "anthropic",
            })
          : new mockMod.MockModelProvider(),
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
