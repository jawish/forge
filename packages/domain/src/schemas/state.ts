// Zod schemas for the session state model (docs/11). These mirror the types in
// types/state.ts and ARE the input validators at seams 1/5 (docs/10 §2).
// Keep schema + type in lockstep: types are derived via z.infer where useful.

import { z } from "zod";

export const sessionStatusSchema = z.enum([
  "queued",
  "active",
  "ready_for_pr",
  "pr_open",
  "merged",
  "closed",
  "no_change",
  "failed",
  "cancelled",
]);
export type SessionStatusZod = z.infer<typeof sessionStatusSchema>;

export const terminalStatusSchema = z.enum([
  "merged",
  "closed",
  "no_change",
  "failed",
  "cancelled",
]);

export const sessionActivitySchema = z.enum([
  "provisioning",
  "running",
  "awaiting_input",
  "paused",
  "stuck",
]);

/** activity is null unless status === 'active' (docs/11 §1). Enforced in state machine. */
export const nullableActivitySchema = sessionActivitySchema.nullable();

export const sessionOutcomeSchema = z.enum([
  "merged",
  "closed",
  "no_change",
  "failed",
  "cancelled",
]);
