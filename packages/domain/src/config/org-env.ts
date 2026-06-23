// Platform/org config (D1) and env/infra config (Pulumi) schemas — docs/13 §3, §4.
// Stubs for now; widened during Phase 1 as concrete settings land. The shapes
// are locked enough to validate admin input and Pulumi stack output.

import { z } from "zod";

/**
 * Org-level config stored in D1 (docs/13 §3). Global, cross-repo. Edited by
 * Platform/admins via admin UI or API. The map holds typed blobs; widen with
 * named keys as concrete settings emerge.
 */
export const orgConfigSchema = z.object({
  globalModelDefaults: z
    .object({
      default: z.string().optional(),
      fallbackTier: z.enum(["frontier", "default", "flex", "specialist"]).optional(),
    })
    .default({}),
  reviewAgentPolicyDefault: z.boolean().default(false),
  modelProviderRouting: z.record(z.string(), z.boolean()).default({}), // provider id -> enabled
  // KV kill-switch lives in KV (flag:killswitch), not here — checked synchronously
  // before every model call (08 §17).
});

export type OrgConfig = z.infer<typeof orgConfigSchema>;

/**
 * Env/infra config — Pulumi stack output shape (docs/13 §4). Resource IDs +
 * secret references bound to Workers at deploy. Not in any repo's .forge/.
 */
export const envConfigSchema = z.object({
  env: z.enum(["dev", "staging", "prod"]),
  // Pulumi-provided resource IDs (bound to Workers at deploy)
  d1DatabaseId: z.string(),
  r2ArtifactsBucket: z.string(),
  r2AuditBucket: z.string(),
  kvNamespaceId: z.string(),
  vectorizeIndexName: z.string().optional(),
  // Secret *references* (names in CF Secrets Store), never values
  secrets: z
    .object({
      aiGatewayKey: z.string(),
      sandboxCreds: z.string().optional(),
      githubAppKey: z.string().optional(),
      slackTokens: z.string().optional(),
      clickhouseCreds: z.string().optional(),
      oauthMasterKey: z.string(),
    })
    .passthrough(),
});

export type EnvConfig = z.infer<typeof envConfigSchema>;
