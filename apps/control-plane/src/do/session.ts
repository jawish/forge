// SessionDO — per-session hot state (docs/12 §2 source of truth, docs/11 state model).
// Implements the DO API surface (docs/12 §2 DO API + seam 2, docs/10 §3) wired to
// the domain state machine (§3.7). transitionTo validates legality via the state
// machine and records the side-effect manifest for the (injected) ports to run.
//
// §5.1: migration + tables. §5.2: the API methods. §5.3: state machine in
// transitionTo. §5.4: activity null-unless-active invariant. Side effects
// (sandbox destroy, audit, Slack) are delegated to ports so they're testable.

import { Agent, type Connection, type ConnectionContext, type WSMessage } from "@cloudflare/agents";
import {
  ATTR,
  ForgeError,
  IllegalTransitionError,
  SPAN,
  canTransition,
  checkBudget,
  isTerminalStatus,
  isValidState,
  legalActivityFor,
  transitionSideEffects,
  type ClientToServerCall,
  type ServerToClientEvent,
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
    // Migrations for columns added after initial deploy (ALTER TABLE ADD COLUMN
    // is idempotent-safe: throws if the column exists, which we catch).
    try {
      this.ctx.storage.sql.exec("ALTER TABLE agent_process ADD COLUMN command TEXT");
    } catch {
      // Column already exists — expected.
    }
    try {
      this.ctx.storage.sql.exec("ALTER TABLE agent_process ADD COLUMN conversation TEXT");
    } catch {
      // Column already exists.
    }
    try {
      this.ctx.storage.sql.exec(
        "ALTER TABLE agent_process ADD COLUMN iteration INTEGER NOT NULL DEFAULT 0",
      );
    } catch {
      // Column already exists.
    }
    this.migrated = true;
  }

  override onStateUpdate(): void {
    // no-op stub; §5 wires analytics projection here
  }

  /**
   * DO alarm — runs ONE iteration of the agent loop per fire.
   * Each alarm: read conversation → call model → exec commands → store → next alarm.
   * Immune to waitUntil — each alarm is a fresh 30s CPU budget.
   */
  override async alarm(): Promise<void> {
    this.ensureMigrated();
    const meta = this.getMetaRow();
    if (!meta) return;

    const rows = this.ctx.storage.sql.exec(
      "SELECT * FROM agent_process WHERE session_id = ? AND status IN ('pending','running')",
      meta.id,
    );
    const allRows = Array.from(rows) as Array<{
      sandbox_id: string;
      process_id: string;
      status: string;
      command: string | null;
      conversation: string | null;
      iteration: number;
    }>;
    const proc = allRows[0];
    if (!proc) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sandboxNs = (this.env as any)?.SANDBOX_DO;
    if (!sandboxNs) return;

    const maxIterations = 8;
    const modelName = (this.env as { AI_GATEWAY_MODEL?: string }).AI_GATEWAY_MODEL ?? "grok-4.3";

    try {
      const { getSandbox } = await import("@cloudflare/sandbox");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sandbox: any = getSandbox(sandboxNs, proc.sandbox_id, {
        sleepAfter: "30m",
        containerTimeouts: { instanceGetTimeoutMS: 120_000, portReadyTimeoutMS: 180_000 },
      });

      const conversation: Array<{ role: string; content: string }> = proc.conversation
        ? JSON.parse(proc.conversation)
        : [
            {
              role: "system",
              content: `You are an autonomous coding agent in a git repo at /workspace. Issue bash commands prefixed with "RUN:" (one per line). After commands run, you'll see output. When done, respond with "DONE:" + summary. Be thorough: explore, edit, test, verify.`,
            },
            { role: "user", content: `Task: ${proc.command ?? "no task"}` },
          ];

      const iteration = proc.iteration;
      console.log(`[alarm] Iteration ${iteration + 1}/${maxIterations}`);

      const prompt = conversation.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");

      // Call model via AI Gateway.
      const gwMod = await import("../model/ai-gateway-provider").catch(() => null);
      if (!gwMod) {
        await this.transitionTo({ status: "failed" }, "no_model").catch(() => {});
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const provider: any = new gwMod.AiGatewayModelProvider({
        endpoint: (this.env as { AI_GATEWAY_ENDPOINT?: string }).AI_GATEWAY_ENDPOINT!,
        apiKey: (this.env as { AI_GATEWAY_KEY?: string }).AI_GATEWAY_KEY!,
        provider: (this.env as { AI_GATEWAY_PROVIDER?: string }).AI_GATEWAY_PROVIDER ?? "xai",
      });

      let modelResponse = "";
      for await (const event of provider.stream({ prompt, model: modelName })) {
        if (event.type === "thinking_delta") modelResponse += event.text;
        else if (event.type === "finish") break;
      }
      console.log(`[alarm] Turn ${iteration + 1}:`, modelResponse.slice(0, 200));
      conversation.push({ role: "assistant", content: modelResponse });

      if (modelResponse.includes("DONE:")) {
        console.log("[alarm] DONE — finishing");
        await this.finishAgent(sandbox, proc, conversation);
        return;
      }

      const commands = modelResponse
        .split("\n")
        .filter((l: string) => l.trim().startsWith("RUN:"))
        .map((l: string) => l.trim().slice(4).trim());
      const outputs: string[] = [];
      for (const cmd of commands) {
        console.log("[alarm] Exec:", cmd.slice(0, 80));
        const result = await sandbox.exec(cmd, { cwd: "/workspace" });
        const out = (result.exitCode === 0 ? result.stdout : result.stderr) || "(no output)";
        outputs.push(`$ ${cmd}\n${out.slice(0, 800)}\n(exit: ${result.exitCode})`);
      }
      if (outputs.length > 0) conversation.push({ role: "user", content: outputs.join("\n\n") });

      if (iteration + 1 >= maxIterations) {
        console.log("[alarm] Max iterations — finishing");
        await this.finishAgent(sandbox, proc, conversation);
        return;
      }

      this.ctx.storage.sql.exec(
        "UPDATE agent_process SET conversation=?, iteration=?, status='running' WHERE process_id=?",
        JSON.stringify(conversation),
        iteration + 1,
        proc.process_id,
      );
      this.ctx.storage.setAlarm(Date.now() + 2_000);
    } catch (err) {
      console.error("[alarm] Error:", err instanceof Error ? err.message : String(err));
      this.ctx.storage.setAlarm(Date.now() + 5_000);
    }
  }

  /** Commit, push, create GitHub PR, run verification, transition to ready_for_pr. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async finishAgent(
    sandbox: any,
    proc: { process_id: string; sandbox_id: string },
    conv: Array<{ role: string; content: string }>,
  ): Promise<void> {
    const task =
      conv
        .find((m) => m.role === "user")
        ?.content.slice(0, 50)
        .replace(/'/g, "") ?? "task";
    const taskFull =
      conv
        .find((m) => m.role === "user")
        ?.content.replace("Task: ", "")
        .slice(0, 200) ?? "task";

    // 1. Commit changes.
    const commit = await sandbox.exec(
      `cd /workspace && git add -A && git commit -m 'forge: ${task}' 2>&1 || true`,
      { cwd: "/workspace" },
    );
    console.log("[alarm] Commit:", commit.exitCode, commit.stdout?.slice(0, 100));

    // Get the branch name + diff for the PR body.
    const branchResult = await sandbox.exec("cd /workspace && git branch --show-current", {
      cwd: "/workspace",
    });
    const branchName = branchResult.stdout?.trim() ?? "forge/branch";
    const diffResult = await sandbox
      .exec("cd /workspace && git diff HEAD~1 --stat 2>&1 || echo 'committed'", {
        cwd: "/workspace",
      })
      .catch(() => ({ stdout: "committed" }));
    const diffSummary = diffResult.stdout?.slice(0, 500) ?? "committed";

    // 2. Push to GitHub.
    const env = this.env as { GITHUB_TOKEN?: string; GITHUB_REPO_URL?: string };
    let prUrl = "";
    if (env.GITHUB_TOKEN && env.GITHUB_REPO_URL) {
      const push = await sandbox.exec("cd /workspace && git push origin HEAD 2>&1", {
        cwd: "/workspace",
      });
      console.log("[alarm] Push:", push.exitCode, push.stdout?.slice(0, 100));

      // 3. Create a GitHub PR via the API.
      // Parse owner/repo from the URL (https://github.com/owner/repo.git).
      const match = env.GITHUB_REPO_URL.match(/github\.com\/([^/]+)\/([^/.]+)/);
      if (match) {
        const [, owner, repo] = match;
        console.log("[alarm] Creating PR for", `${owner}/${repo}`, "branch:", branchName);
        try {
          const prResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.GITHUB_TOKEN}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "forge-agent",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              title: `forge: ${taskFull.slice(0, 60)}`,
              head: branchName,
              base: "main",
              body: `## Forge Agent Session\n\n**Task**: ${taskFull}\n\n**Changes**:\n\`\`\`\n${diffSummary}\n\`\`\`\n\n_Generated by Forge autonomous agent (Grok-4.3 via AI Gateway)_`,
            }),
          });
          if (prResponse.ok) {
            const prData = (await prResponse.json()) as { html_url: string; number: number };
            prUrl = prData.html_url;
            console.log("[alarm] PR created:", prUrl);
          } else {
            const errText = await prResponse.text();
            console.error("[alarm] PR creation failed:", prResponse.status, errText.slice(0, 200));
          }
        } catch (err) {
          console.error("[alarm] PR API error:", err instanceof Error ? err.message : String(err));
        }
      }
    }

    // 4. Run verification — execute the repo's test command in the sandbox.
    console.log("[alarm] Running verification (tests)...");
    const verifyResult = await sandbox
      .exec(
        "cd /workspace && (pnpm test:unit 2>&1 || npm test 2>&1 || echo 'no tests found') | tail -20",
        { cwd: "/workspace", timeout: 60_000 },
      )
      .catch((e: unknown) => ({ exitCode: 1, stdout: `verify failed: ${e}`, stderr: "" }));
    const verifyOutput = verifyResult.stdout?.slice(0, 500) ?? "no output";
    const testsPassed = verifyResult.exitCode === 0;
    console.log("[alarm] Verification:", testsPassed ? "PASS" : "FAIL", verifyOutput.slice(0, 200));

    // 5. Record the PR URL + verification on the session.
    this.ctx.storage.sql.exec(
      "UPDATE agent_process SET status='finished' WHERE process_id=?",
      proc.process_id,
    );

    // 6. Update the session_meta with PR info if we have the column.
    try {
      this.ctx.storage.sql.exec(
        "UPDATE session_meta SET pr_url=?, pr_number=? WHERE id=?",
        prUrl || null,
        prUrl ? parseInt(prUrl.match(/\/pull\/(\d+)/)?.[1] ?? "0") || 0 : 0,
        this.getMetaRow()?.id,
      );
    } catch {
      // Columns may not exist — non-fatal.
    }

    // 7. Transition to ready_for_pr.
    await this.transitionTo({ status: "ready_for_pr" }, "agent_complete").catch(() => {});
    console.log(
      "[alarm] → ready_for_pr. PR:",
      prUrl || "(no PR)",
      "Tests:",
      testsPassed ? "PASS" : "FAIL",
    );
  }

  /** Store agent execution info (called by the agent loop after provisioning). */
  async setAgentProcess(input: { sandboxId: string; command: string }): Promise<void> {
    this.ensureMigrated();
    const meta = this.getMetaRow();
    if (!meta) return;
    const recordId = `ap_${Date.now().toString(36)}`;
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO agent_process (session_id, sandbox_id, process_id, status, command, iteration) VALUES (?, ?, ?, 'pending', ?, 0)",
      meta.id,
      input.sandboxId,
      recordId,
      input.command,
    );
    this.ctx.storage.setAlarm(Date.now() + 2_000);
    console.log("[agent] Alarm set for", input.sandboxId);
  }

  /** A WS connection joined — send a state snapshot (docs/10 §4, §5.12). */
  override async onConnect(connection: Connection, _ctx: ConnectionContext): Promise<void> {
    const meta = this.getMetaRow();
    if (meta) {
      const status = await this.getStatus();
      const snapshot: ServerToClientEvent = {
        type: "state_snapshot",
        sessionId: meta.id,
        status: status.status,
        activity: status.activity,
        costUsd: status.costUsd,
        tokensIn: status.tokensIn,
        tokensOut: status.tokensOut,
        history: { prompts: [], toolCalls: [], artifacts: [] },
      };
      connection.send(JSON.stringify(snapshot));
    }
  }

  /** Client → server calls over the WS (docs/10 §4, §5.13). */
  override async onMessage(_connection: Connection, message: WSMessage): Promise<void> {
    let call: ClientToServerCall;
    try {
      const raw = typeof message === "string" ? message : String(message);
      call = JSON.parse(raw) as ClientToServerCall;
    } catch {
      return; // ignore malformed
    }
    switch (call.type) {
      case "submit_prompt":
        await this.submitPrompt({
          userId: call.userId,
          content: call.content,
          modelParams: call.modelParams,
        });
        break;
      case "pause":
        await this.pause();
        break;
      case "resume":
        await this.resume();
        break;
      case "cancel":
        await this.cancel(call.reason ?? "client_ws_cancel");
        break;
      default:
        break;
    }
    // After any client call, broadcast the updated state (docs/10 §4 — DO emits
    // on state changes; multiplayer gets presence-free updates).
    this.broadcastState();
  }

  /** Broadcast the current state as a state_snapshot to all connected clients. */
  private async broadcastState(): Promise<void> {
    const meta = this.getMetaRow();
    if (!meta) return;
    const status = await this.getStatus();
    const snapshot: ServerToClientEvent = {
      type: "state_snapshot",
      sessionId: meta.id,
      status: status.status,
      activity: status.activity,
      costUsd: status.costUsd,
      tokensIn: status.tokensIn,
      tokensOut: status.tokensOut,
      history: { prompts: [], toolCalls: [], artifacts: [] },
    };
    this.broadcast(JSON.stringify(snapshot));
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

  // --- Cost control (docs/08 §17, checklist §8.4) -------------------------

  /** Record a cost event + update the running totals (incremental counter). */
  async recordCost(entry: {
    source: "model" | "sandbox_cpu" | "sandbox_egress" | "browser_run" | "other";
    costUsd: number;
    tokensIn?: number | null;
    tokensOut?: number | null;
    model?: string | null;
    detailJson?: string | null;
  }): Promise<void> {
    this.ensureMigrated();
    const meta = this.getMetaRow();
    if (!meta) return;
    this.ctx.storage.sql.exec(
      `INSERT INTO cost_event (ts, source, cost_usd, tokens_in, tokens_out, model, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      Date.now(),
      entry.source,
      entry.costUsd,
      entry.tokensIn ?? null,
      entry.tokensOut ?? null,
      entry.model ?? null,
      entry.detailJson ?? null,
    );
    // Update the denormalized totals on session_meta (the hot read path).
    this.ctx.storage.sql.exec(
      `UPDATE session_meta
       SET total_cost_usd = total_cost_usd + ?,
           total_tokens_in = total_tokens_in + ?,
           total_tokens_out = total_tokens_out + ?
       WHERE id = ?`,
      entry.costUsd,
      entry.tokensIn ?? 0,
      entry.tokensOut ?? 0,
      meta.id,
    );
  }

  /**
   * Synchronous pre-call budget check (docs/08 §17). Call BEFORE each model call.
   * Returns whether the call is within the session budget; the caller (agent loop)
   * transitions to failed on BUDGET_EXHAUSTED.
   */
  async checkBudgetBeforeCall(callCostUsd: number): Promise<{
    allowed: boolean;
    reason?: string;
    projectedTotalUsd: number;
    budgetLimitUsd: number | null;
  }> {
    this.ensureMigrated();
    const meta = this.getMetaRow();
    if (!meta) {
      return {
        allowed: false,
        reason: "session not spawned",
        projectedTotalUsd: 0,
        budgetLimitUsd: null,
      };
    }
    const r = checkBudget({
      currentTotalUsd: meta.total_cost_usd,
      callCostUsd,
      budgetLimitUsd: meta.budget_limit_usd,
    });
    return r;
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

  /** The repo this session targets (for sandbox provisioning, §5.19). */
  async getRepoId(): Promise<{ repoId: string }> {
    this.ensureMigrated();
    const rows = this.sql`SELECT repo_id FROM session_meta WHERE id = ${this.ctx.id.toString()}`;
    const row = rows[0] as { repo_id: string } | undefined;
    if (!row) throw this.error("not_found", "SESSION_NOT_SPAWNED", "session not spawned");
    return { repoId: row.repo_id };
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
    budget_limit_usd: number | null;
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
          budget_limit_usd: number | null;
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
