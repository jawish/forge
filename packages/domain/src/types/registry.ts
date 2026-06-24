// Control-plane OLTP + registry entities (docs/12 §3 D1 projection) and
// R2 audit events (docs/12 §4). These are the derived/index types; the DO
// SQLite source-of-truth types live in session.ts.

import type { SessionActivity, SessionOutcome, SessionStatus } from "./state";

/** A registered target repository Forge can operate on (CONTEXT.md, docs/12 §3 repo). */
export type OnboardingStatus = "pending" | "building" | "ready" | "failed";

export interface Repo {
  id: string;
  githubOrg: string; // e.g. 'mycompany'
  githubRepo: string; // e.g. 'monolith'
  defaultBranch: string; // default 'main'
  imageConfigJson: string; // Dockerfile ref, setup scripts, base image
  tuningJson: string; // prewarm commands, MCP allowlist, model defaults, policy (11 §6)
  onboardingStatus: OnboardingStatus;
  createdAt: number;
  updatedAt: number;
}

/** A specific built sandbox image: immutable, signed (CONTEXT.md, docs/12 §3). */
export type BuildStatus = "success" | "failed";

export interface RepoImageVersion {
  id: string;
  repoId: string;
  version: string; // semver or commit-sha-derived
  gitSha: string;
  builtAt: number;
  buildStatus: BuildStatus;
  storageRef: string; // GHCR digest
  signatureRef: string; // cosign signature / Rekor entry
  sbomRef: string; // R2 URI to CycloneDX SBOM
  metricsJson: string | null; // {cold_start_p95, cache_hit_rate, image_size_mb}
}

/** A human engineer authenticated via Google Workspace through CF Access (docs/12 §3). */
export interface ForgeUser {
  id: string; // stable id (sub from CF Access JWT)
  email: string;
  displayName: string | null;
  githubOauthTokenEncrypted: string | null; // null until first PR; master key in Secrets Store
  githubUsername: string | null;
  teamId: string | null;
  createdAt: number;
  lastActiveAt: number | null;
}

/** A team, for budgets/quotas/access scoping (docs/12 §3 team). */
export interface Team {
  id: string;
  name: string;
  budgetLimitUsdDaily: number | null;
  budgetLimitUsdWeekly: number | null;
  createdAt: number;
}

/** D1 session projection row (docs/12 §3 session) — the dashboard list/filter index. */
export interface SessionIndexRow {
  id: string;
  repoId: string;
  branch: string;
  createdByUserId: string;
  parentSessionId: string | null;
  rootSessionId: string;
  status: SessionStatus;
  activity: SessionActivity | null;
  primaryModel: string | null;
  sandboxImageVersion: string | null;
  prUrl: string | null;
  prNumber: number | null;
  createdAt: number;
  endedAt: number | null;
  mergedAt: number | null;
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  outcome: SessionOutcome | null;
  failureReason: string | null;
}

/** Actor type for audit events (docs/12 §4). */
export type ActorType = "user" | "system" | "agent";

/** Target descriptor for an audit event (docs/12 §4). */
export type AuditTargetType = "file" | "repo" | "pr" | "mcp" | "session";

export interface AuditTarget {
  type: AuditTargetType;
  id: string;
}

/** An auditable action (CONTEXT.md, docs/12 §4). One JSONL object per event. */
export type AuditAction =
  | "prompt"
  | "tool_call"
  | "edit"
  | "commit"
  | "pr_create"
  | "policy_change"
  | "status_transition";

export interface AuditEvent {
  eventId: string;
  sessionId: string;
  ts: number;
  actorId: string;
  actorType: ActorType;
  action: AuditAction;
  target: AuditTarget;
  beforeJson: string | null; // null for creates
  afterJson: string | null;
  correlationId: string; // OTel trace id for cross-referencing
  prevHash: string | null; // Merkle chain link
  thisHash: string; // sha256(this_event_canonical_json || prev_hash)
}
