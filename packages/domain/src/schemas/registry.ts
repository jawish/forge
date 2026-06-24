// Zod schemas for registry/D1 projection entities (docs/12 §3) + R2 audit
// events (docs/12 §4). Mirror types/registry.ts.

import { z } from "zod";
import { nullableActivitySchema, sessionOutcomeSchema, sessionStatusSchema } from "./state";

export const onboardingStatusSchema = z.enum(["pending", "building", "ready", "failed"]);
export const buildStatusSchema = z.enum(["success", "failed"]);

export const repoSchema = z.object({
  id: z.string().min(1),
  githubOrg: z.string().min(1),
  githubRepo: z.string().min(1),
  defaultBranch: z.string().min(1),
  imageConfigJson: z.string(),
  tuningJson: z.string(),
  onboardingStatus: onboardingStatusSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const repoImageVersionSchema = z.object({
  id: z.string().min(1),
  repoId: z.string().min(1),
  version: z.string().min(1),
  gitSha: z.string().min(1),
  builtAt: z.number().int().nonnegative(),
  buildStatus: buildStatusSchema,
  storageRef: z.string().min(1),
  signatureRef: z.string().min(1),
  sbomRef: z.string().min(1),
  metricsJson: z.string().nullable(),
});

export const forgeUserSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  displayName: z.string().nullable(),
  githubOauthTokenEncrypted: z.string().nullable(),
  githubUsername: z.string().nullable(),
  teamId: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  lastActiveAt: z.number().int().nullable(),
});

export const teamSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  budgetLimitUsdDaily: z.number().nonnegative().nullable(),
  budgetLimitUsdWeekly: z.number().nonnegative().nullable(),
  createdAt: z.number().int().nonnegative(),
});

export const sessionIndexRowSchema = z.object({
  id: z.string().min(1),
  repoId: z.string().min(1),
  branch: z.string().min(1),
  createdByUserId: z.string().min(1),
  parentSessionId: z.string().nullable(),
  rootSessionId: z.string().min(1),
  status: sessionStatusSchema,
  activity: nullableActivitySchema,
  primaryModel: z.string().nullable(),
  sandboxImageVersion: z.string().nullable(),
  prUrl: z.string().nullable(),
  prNumber: z.number().int().nullable(),
  createdAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nullable(),
  mergedAt: z.number().int().nullable(),
  totalCostUsd: z.number().nonnegative(),
  totalTokensIn: z.number().int().nonnegative(),
  totalTokensOut: z.number().int().nonnegative(),
  outcome: sessionOutcomeSchema.nullable(),
  failureReason: z.string().nullable(),
});

// --- Audit (docs/12 §4) -----------------------------------------------------

export const actorTypeSchema = z.enum(["user", "system", "agent"]);
export const auditTargetTypeSchema = z.enum(["file", "repo", "pr", "mcp", "session"]);
export const auditActionSchema = z.enum([
  "prompt",
  "tool_call",
  "edit",
  "commit",
  "pr_create",
  "policy_change",
  "status_transition",
]);

export const auditTargetSchema = z.object({
  type: auditTargetTypeSchema,
  id: z.string().min(1),
});

export const auditEventSchema = z.object({
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  ts: z.number().int().nonnegative(),
  actorId: z.string().min(1),
  actorType: actorTypeSchema,
  action: auditActionSchema,
  target: auditTargetSchema,
  beforeJson: z.string().nullable(),
  afterJson: z.string().nullable(),
  correlationId: z.string().min(1),
  prevHash: z.string().nullable(),
  thisHash: z.string().min(1),
});
