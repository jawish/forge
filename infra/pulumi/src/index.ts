// Forge IaC — Pulumi program (docs/17 §2, checklist §6.6).
// Provisions the CF resource surface the platform depends on, per-stack. This is
// the minimal dev-stack sufficient for local `real` (§6.6); prod-grade IaC widens
// later (Object Lock config, Access policies, full Vectorize, etc.).
//
// Run: `pulumi up -s dev` (needs CF account creds via `pulumi config set-secret`).
// Stack differences are config-driven (resource name prefixes, tier, secrets scope).

import * as cf from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const accountId = config.require("cloudflare:accountId");
const env = pulumi.getStack(); // dev | staging | prod
const namePrefix = `forge-${env}`;

// --- D1: control-plane OLTP index (docs/12 §3) -----------------------------
const d1Database = new cf.D1Database("control-plane-db", {
  accountId,
  name: `${namePrefix}-control-plane`,
});

// --- R2: blobs + WORM audit (docs/12 §4) -----------------------------------
// Note: Object Lock Compliance mode is configured on the audit bucket via the
// CF dashboard/API for prod (the provider support is tracked); the bucket exists here.
const artifactsBucket = new cf.R2Bucket("artifacts", {
  accountId,
  name: `${namePrefix}-artifacts`,
});
const sandboxesBucket = new cf.R2Bucket("sandboxes", {
  accountId,
  name: `${namePrefix}-sandboxes`,
});
void sandboxesBucket; // referenced by the sandbox snapshot lifecycle (§6.3)
const auditBucket = new cf.R2Bucket("audit", {
  accountId,
  name: `${namePrefix}-audit`,
});

// --- KV: config cache + flags (docs/12 §6) ---------------------------------
const configKv = new cf.WorkersKvNamespace("config-kv", {
  accountId,
  title: `${namePrefix}-config`,
});

// --- Queues: async work (docs/12) ------------------------------------------
const workQueue = new cf.Queue("work-queue", {
  accountId,
  queueName: `${namePrefix}-work`,
});

// --- AI Gateway: unified model call surface (docs/08 §6) -------------------
const aiGateway = new cf.AiGateway("ai-gateway", {
  accountId,
  aiGatewayId: `${namePrefix}-gateway`,
  // Caching + rate limits + cost tracking + per-provider fallback (docs/08 §6).
  cacheInvalidateOnUpdate: false,
  cacheTtl: 3600,
  collectLogs: true,
  rateLimitingInterval: 1,
  rateLimitingLimit: 1000,
});

// --- Workers: control-plane + web (docs/09 §3) -----------------------------
// The control-plane Worker binds the DO namespace + D1/R2/KV/Queues + AI Gateway.
// (Worker source is deployed via CF Workers Builds on push — docs/17 §5 — so the
// Pulumi resource here defines the bindings; the code ships from the repo.)
// §6.6 minimal: the resources above are what local `real` needs to reference.
// The Worker resources + DO namespace + Access policies widen in prod-grade IaC.

// --- Vectorize: classifier index (docs/12 §7) ------------------------------
// Created when the Workers AI + Vectorize bindings are provisioned (§8.1 seeding).
// const repoClassifier = new cf.VectorizeIndex("repo-classifier", { ... });

// --- Outputs: the IDs/refs wrangler.jsonc + .dev.vars reference -------------
export const d1DatabaseId = d1Database.uuid;
export const kvNamespaceId = configKv.id;
export const aiGatewayId = aiGateway.id;
export const artifactsBucketName = artifactsBucket.name;
export const auditBucketName = auditBucket.name;
export const workQueueName = workQueue.queueName;
export const envName = env;
