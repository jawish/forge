// Repo config schema — validates .forge/config.toml (docs/13 §2).
// This is the canonical source for all per-repo config (build AND runtime).
// The control plane parses .forge/config.toml on webhook, validates with this
// schema, and projects to D1 (repo.tuning_json — read-only).
//
// NOTE: keys are snake_case to match TOML convention + the docs/13 §2 example
// verbatim. The TS output type carries the same snake_case keys (config is data,
// not an internal TS API) so there's no naming drift between file, schema, and code.

import { z } from "zod";

// Sections with runtime defaults are defined with field defaults so an omitted
// section (or omitted field) parses cleanly. zod 4's .default() on a nested
// all-defaulted object doesn't type-check, so defaulted sections use a preprocess
// coercion (absence/null -> {}) — clean input, clean output, runtime-correct.

export const buildConfigSchema = z.object({
  dockerfile: z.string().min(1),
  setup_script: z.string().min(1),
  base_image: z.string().min(1),
});

export const prewarmConfigSchema = z.object({
  commands: z.array(z.string()).default([]),
  warm_pool_size: z.number().int().nonnegative().default(0),
});

export const modelConfigSchema = z.object({
  default: z.string().min(1),
  fallback_tier: z.enum(["frontier", "default", "flex", "specialist"]).default("flex"),
});

export const mcpConfigSchema = z.object({
  allowlist: z.array(z.string()).default([]),
});

export const policyConfigSchema = z.object({
  review_agent_required: z.boolean().default(false),
  stuck_threshold_turns: z.number().int().positive().default(10),
  stuck_timeout_minutes: z.number().int().positive().default(5),
  budget_limit_usd: z.number().nonnegative().nullable().default(5.0),
});

export const pathsConfigSchema = z.object({
  sensitive: z.array(z.string()).default([]),
  readonly: z.array(z.string()).default([]),
});

export const gitIdentityStrategySchema = z.enum(["user", "bot"]);

export const gitConfigSchema = z.object({
  identity_strategy: gitIdentityStrategySchema.default("user"),
  default_branch: z.string().min(1).default("main"),
});

// Absence (or null) of a defaulted section normalizes to {} before field defaults apply.
const defaulted = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === undefined || v === null ? {} : v), schema);

const rawRepoConfigSchema = z.object({
  build: buildConfigSchema,
  prewarm: defaulted(prewarmConfigSchema),
  model: modelConfigSchema,
  mcp: defaulted(mcpConfigSchema),
  policy: defaulted(policyConfigSchema),
  paths: defaulted(pathsConfigSchema),
  git: defaulted(gitConfigSchema),
});

/**
 * The full .forge/config.toml schema (docs/13 §2). build + model are required;
 * the rest default to {} when absent (their fields carry their own defaults).
 * A minimal config (build + model only) is valid.
 */
export const repoConfigSchema = rawRepoConfigSchema;

export type RepoConfig = z.infer<typeof repoConfigSchema>;
export type BuildConfig = z.infer<typeof buildConfigSchema>;
export type PrewarmConfig = z.infer<typeof prewarmConfigSchema>;
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export type McpConfig = z.infer<typeof mcpConfigSchema>;
export type PolicyConfig = z.infer<typeof policyConfigSchema>;
export type PathsConfig = z.infer<typeof pathsConfigSchema>;
export type GitConfig = z.infer<typeof gitConfigSchema>;
export type GitIdentityStrategy = z.infer<typeof gitIdentityStrategySchema>;
