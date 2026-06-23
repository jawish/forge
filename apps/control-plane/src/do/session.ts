// SessionDO — per-session hot state (docs/12 §2 source of truth, docs/11 state model).
// Implements the DO API surface (docs/12 §2 DO API + seam 2, docs/10 §3) wired to
// the domain state machine (§3.7). transitionTo validates legality via the state
// machine and records the side-effect manifest for the (injected) ports to run.
//
// §5.1: migration + tables. §5.2: the API methods. §5.3: state machine in
// transitionTo. §5.4: activity null-unless-active invariant. Side effects
// (sandbox destroy, audit, Slack) are delegated to ports so they're testable.

import { Agent } from "@cloudflare/agents";
import {
  ATTR,
  ForgeError,
  IllegalTransitionError,
  SPAN,
  canTransition,
  isTerminalStatus,
  isValidState,
  legalActivityFor,
  transitionSideEffects,
  type SessionActivity,
  type SessionStatus,
} from "@forge/domain";
import type { Env } from "../env";
import { newCorrelationId, startSpan } from "../otel/console";
import { SCHEMA_VERSION, SESSION_DO_MIGRATION_STATEMENTS } from "./schema";

/** Cached session_meta (status/activity/cost) — the live state. */
export interface SessionDOState {
  sessionId: string | null;
  status: SessionStatus | null;
  activity: SessionActivity | null;
}

/**
 * Ports the DO delegates side effects to (docs/11 §4 side-effect manifest).
 * Injected (in §5.3 / tests) so the DO's behavior is testable without real
 * Slack/R2/sandbox. Each method matches a side-effect id from the state machine.
 */
export interface SessionDOPorts {
  startCostCounter?(sessionId: string): Promise<void>;
  destroySandbox?(sandboxId: string): Promise<void>;
  emitAudit?(action: string, payload: unknown): Promise<void>;
  postSlack?(message: string): Promise<void>;
}

export class SessionDO extends Agent<Env, SessionDOState> {
  /** Side-effect ports; set via setPorts (defaults are no-ops). */
  private ports: SessionDOPorts = {};
  /** Whether the SQLite migration has run for this DO instance. */
  private migrated = false;

  /** Inject side-effect ports (tests / §5.3 wiring). */
  setPorts(ports: SessionDOPorts): void {
    this.ports = ports;
  }

  /** Run the migration once per DO instance (docs/12 §8 — code-level migration). */
  private ensureMigrated(): void {
    if (this.migrated) return;
    // sql.exec runs ONE statement per call (multi-statement strings no-op beyond
    // the first), so exec each statement individually (docs/12 §8).
    for (const stmt of SESSION_DO_MIGRATION_STATEMENTS) {
      this.ctx.storage.sql.exec(stmt);
    }
    this.migrated = true;
  }

  override onStateUpdate(): void {
    // no-op stub; §5 wires analytics projection here
  }

  override onConnect(): void {
    // §5.11–5.13 wires the WS event stream
  }

  // --- Lifecycle (docs/12 §2 DO API) ---------------------------------------

  /** Create the session: insert session_meta, status_history (spawn -> queued). */
  async spawn(input: {
    repoId: string;
    branch: string;
    createdByUserId: string;
    parentSessionId?: string;
    budgetLimitUsd?: number;
    primaryModel?: string;
  }): Promise<{ sessionId: string }> {
    this.ensureMigrated();
    const sessionId = this.ctx.id.toString();
    const span = startSpan(SPAN.SESSION_SPAWN, { [ATTR.SESSION_ID]: sessionId });

    const now = Date.now();
    const status: SessionStatus = "queued";
    // Spawn creates the session in queued; provisioning then transitions to active.
    this.ctx.storage.sql.exec(
      `INSERT INTO session_meta
        (id, repo_id, branch, created_by_user_id, parent_session_id, root_session_id,
         status, activity, primary_model, budget_limit_usd, created_at, total_cost_usd,
         total_tokens_in, total_tokens_out)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, 0, 0)`,
      sessionId,
      input.repoId,
      input.branch,
      input.createdByUserId,
      input.parentSessionId ?? null,
      input.parentSessionId ?? sessionId, // root = self unless sub-session
      status,
      input.primaryModel ?? null,
      input.budgetLimitUsd ?? null,
      now,
    );
    this.recordStatusHistory(null, null, status, null, "spawn", input.createdByUserId, now);
    this.setState({ sessionId, status, activity: null });
    span.end();
    return { sessionId };
  }

  /**
   * transitionTo — the heart of seam 2 (docs/11 §7, §3.7). Validates legality via
   * the domain state machine; on illegal moves throws IllegalTransitionError.
   * Writes status_history; enforces activity-null-unless-active; runs side effects
   * by invoking the injected ports matching the manifest.
   */
  async transitionTo(
    to: { status?: SessionStatus; activity?: SessionActivity | null },
    reason: string,
  ): Promise<{
    from: { status: SessionStatus | null; activity: SessionActivity | null };
    to: { status: SessionStatus; activity: SessionActivity | null };
  }> {
    this.ensureMigrated();
    const meta = this.getMetaRow();
    if (!meta) {
      throw this.error("not_found", "SESSION_NOT_SPAWNED", "session not spawned");
    }
    const fromStatus = meta.status;
    const fromActivity = meta.activity;

    // Status transition (if requested): validate via the state machine.
    let toStatus = fromStatus;
    if (to.status && to.status !== fromStatus) {
      if (!canTransition(fromStatus, to.status)) {
        throw new IllegalTransitionError(fromStatus, to.status, newCorrelationId());
      }
      toStatus = to.status;
    }

    // Activity: must be null unless status === 'active' (docs/11 §1, §3).
    // Entering active defaults to 'provisioning' if no activity is given
    // (docs/11 §3: provisioning is set on session spawn → active).
    let toActivity = to.activity !== undefined ? to.activity : fromActivity;
    const allowedActivities = legalActivityFor(toStatus);
    if (toStatus !== "active") {
      toActivity = null; // enforced in code, not just CHECK (docs/11 §1)
    } else if (toActivity === null) {
      toActivity = "provisioning"; // entering active starts in provisioning
    }
    if (allowedActivities === null) {
      toActivity = null;
    }
    if (!isValidState(toStatus, toActivity)) {
      throw this.error("invalid_input", "ILLEGAL_ACTIVITY", `activity invalid for ${toStatus}`);
    }

    // Persist + history.
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE session_meta SET status = ?, activity = ?, ended_at = ? WHERE id = ?`,
      toStatus,
      toActivity,
      isTerminalStatus(toStatus) ? now : null,
      meta.id,
    );
    this.recordStatusHistory(fromStatus, fromActivity, toStatus, toActivity, reason, "system", now);

    // Run the side-effect manifest (docs/11 §4) via injected ports.
    const effects = transitionSideEffects(fromStatus, toStatus) ?? [];
    await this.runSideEffects(effects, meta);

    this.setState({ sessionId: meta.id, status: toStatus, activity: toActivity });
    return {
      from: { status: fromStatus, activity: fromActivity },
      to: { status: toStatus, activity: toActivity },
    };
  }

  /** cancel — human/admin abort. Routes to the legal cancel transition. */
  async cancel(reason: string): Promise<{ status: SessionStatus }> {
    const meta = this.getMetaRow();
    if (!meta) throw this.error("not_found", "SESSION_NOT_SPAWNED", "session not spawned");
    if (isTerminalStatus(meta.status)) {
      return { status: meta.status }; // already terminal — idempotent
    }
    const { to } = await this.transitionTo({ status: "cancelled" }, reason);
    return { status: to.status };
  }

  // --- Prompts + streaming (docs/12 §2) ------------------------------------

  async submitPrompt(input: {
    userId: string;
    content: string;
    modelParams?: { model: string; reasoning?: string; temperature?: number };
  }): Promise<{ promptId: string }> {
    this.ensureMigrated();
    const meta = this.getMetaRow();
    if (!meta) throw this.error("not_found", "SESSION_NOT_SPAWNED", "session not spawned");
    const promptId = `p_${this.ctx.id.toString()}_${Date.now()}`;
    const modelParams = input.modelParams ?? { model: meta.primary_model ?? "mock" };
    this.ctx.storage.sql.exec(
      `INSERT INTO prompt (id, ts, user_id, prompt_type, content, model_params_json)
       VALUES (?, ?, ?, 'user', ?, ?)`,
      promptId,
      Date.now(),
      input.userId,
      input.content,
      JSON.stringify(modelParams),
    );
    return { promptId };
  }

  async pause(): Promise<void> {
    await this.transitionTo({ activity: "paused" }, "human_pause");
  }
  async resume(): Promise<void> {
    await this.transitionTo({ activity: "running" }, "human_resume");
  }

  // --- Reads (docs/12 §2) --------------------------------------------------

  async getStatus(): Promise<{
    status: SessionStatus;
    activity: SessionActivity | null;
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
  }> {
    this.ensureMigrated();
    const meta = this.getMetaRow();
    if (!meta) throw this.error("not_found", "SESSION_NOT_SPAWNED", "session not spawned");
    return {
      status: meta.status,
      activity: meta.activity,
      costUsd: meta.total_cost_usd,
      tokensIn: meta.total_tokens_in,
      tokensOut: meta.total_tokens_out,
    };
  }

  async getHistory(
    opts: { sinceTs?: number; limit?: number } = {},
  ): Promise<{ prompts: unknown[]; toolCalls: unknown[]; artifacts: unknown[] }> {
    this.ensureMigrated();
    const since = opts.sinceTs ?? 0;
    const limit = opts.limit ?? 100;
    const prompts = this.sql`SELECT * FROM prompt WHERE ts >= ${since} ORDER BY ts LIMIT ${limit}`;
    const promptIds = prompts.map((p) => (p as { id: string }).id);
    const toolCalls =
      promptIds.length > 0
        ? this.sql`SELECT * FROM tool_call WHERE prompt_id IN (${promptIds.join(
            ",",
          )}) ORDER BY ts LIMIT ${limit}`
        : [];
    const artifacts = this
      .sql`SELECT * FROM artifact WHERE ts >= ${since} ORDER BY ts LIMIT ${limit}`;
    return { prompts, toolCalls, artifacts };
  }

  // --- Agent callbacks (seam 5 — MCP tools, docs/10 §6) --------------------

  /** forge.reportStatus — agent updates its activity + summary. */
  async reportStatus(status: { activity?: SessionActivity; summary?: string }): Promise<void> {
    if (status.activity !== undefined) {
      await this.transitionTo(
        { activity: status.activity },
        `agent_report:${status.summary ?? ""}`,
      );
    }
  }

  /** forge.createArtifact — agent/user/review_agent produces a durable output. */
  async createArtifact(artifact: {
    type: "diff" | "test_result" | "screenshot" | "telemetry" | "report" | "review_critique";
    storageUri: string;
    generatedBy: "agent" | "user" | "review_agent";
    mimeType?: string;
    sizeBytes?: number;
    metadataJson?: string;
  }): Promise<{ artifactId: string }> {
    this.ensureMigrated();
    const id = `art_${this.ctx.id.toString()}_${Date.now()}`;
    this.ctx.storage.sql.exec(
      `INSERT INTO artifact (id, ts, type, storage_uri, generated_by, mime_type, size_bytes, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      Date.now(),
      artifact.type,
      artifact.storageUri,
      artifact.generatedBy,
      artifact.mimeType ?? null,
      artifact.sizeBytes ?? null,
      artifact.metadataJson ?? null,
    );
    return { artifactId: id };
  }

  /** forge.requestHumanInput — agent asks a clarifying question (activity=awaiting_input). */
  async requestHumanInput(question: string): Promise<void> {
    await this.transitionTo({ activity: "awaiting_input" }, `agent_input:${question}`);
  }

  /** forge.completePR — agent signals readiness (status=ready_for_pr, activity=null). */
  async completePR(changes: { diffSummary: string; commitSha: string }): Promise<void> {
    await this.transitionTo({ status: "ready_for_pr" }, `agent_complete_pr:${changes.commitSha}`);
  }

  // --- Internals ------------------------------------------------------------

  private getMetaRow(): {
    id: string;
    status: SessionStatus;
    activity: SessionActivity | null;
    primary_model: string | null;
    sandbox_id: string | null;
    total_cost_usd: number;
    total_tokens_in: number;
    total_tokens_out: number;
  } | null {
    const rows = this.sql`SELECT * FROM session_meta WHERE id = ${this.ctx.id.toString()}`;
    const row = rows[0] as
      | {
          id: string;
          status: SessionStatus;
          activity: SessionActivity | null;
          primary_model: string | null;
          sandbox_id: string | null;
          total_cost_usd: number;
          total_tokens_in: number;
          total_tokens_out: number;
        }
      | undefined;
    return row ?? null;
  }

  private recordStatusHistory(
    fromStatus: SessionStatus | null,
    fromActivity: SessionActivity | null,
    toStatus: SessionStatus,
    toActivity: SessionActivity | null,
    reason: string,
    actorId: string,
    ts: number,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO status_history (from_status, to_status, from_activity, to_activity, ts, reason, actor_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      fromStatus,
      toStatus,
      fromActivity,
      toActivity,
      ts,
      reason,
      actorId,
    );
  }

  /** Run the side-effect manifest from the state machine via injected ports. */
  private async runSideEffects(
    effects: ReadonlyArray<{ id: string; description: string }>,
    meta: { sandbox_id: string | null; id: string },
  ): Promise<void> {
    for (const e of effects) {
      switch (e.id) {
        case "start_cost_counter":
          await this.ports.startCostCounter?.(meta.id);
          break;
        case "destroy_sandbox":
          if (meta.sandbox_id) await this.ports.destroySandbox?.(meta.sandbox_id);
          break;
        case "audit_session_started":
        case "audit_session_cancelled":
        case "audit_session_completed":
        case "audit_session_failed":
        case "audit_pr_created":
        case "audit_pr_merged":
        case "audit_pr_closed":
          await this.ports.emitAudit?.(e.id, { sessionId: meta.id });
          break;
        case "slack_thread_started":
        case "slack_thread_failed_to_start":
        case "slack_thread_ready":
        case "slack_thread_no_changes":
        case "slack_thread_failed":
        case "slack_thread_cancelled":
        case "slack_thread_pr_opened":
        case "slack_thread_reopened":
        case "slack_thread_needs_input":
          await this.ports.postSlack?.(e.id);
          break;
        // Other effects (snapshot, restore, create_pr, archive, review artifacts)
        // are wired in §5.19/§8.3 — no-ops here for Phase 0.
        default:
          break;
      }
    }
  }

  private error(
    category:
      | "auth"
      | "not_found"
      | "invalid_input"
      | "budget_exhausted"
      | "transient"
      | "upstream_failure"
      | "internal",
    code: string,
    message: string,
  ): ForgeError {
    return new ForgeError({ category, code, message, correlationId: newCorrelationId() });
  }
}

// Re-export the schema version for tests / migrations tooling.
export { SCHEMA_VERSION };
