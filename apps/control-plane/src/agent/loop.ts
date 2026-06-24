// Agent harness — drives the agent loop (docs/19 §7, §5.21–5.22).
//
// Two execution modes:
// - fast: MockModelProvider drives the loop (for tests + local dev)
// - real: OpenCode runs inside a CF Sandbox as a subprocess. The Worker
//   provisions the sandbox, writes the config, runs `opencode run --format json`,
//   and parses the JSON event stream. The forge.* MCP tools are called by
//   OpenCode back to the Worker's MCP server (/api/mcp), which transitions the DO.
//
// The loop: provision sandbox → boot harness → stream events → translate to DO
// transitions. The DO reaches ready_for_pr / awaiting_input / no_change.

import type { ModelEvent, ModelProvider } from "../model/provider";
import type { SandboxProvider } from "../sandbox/provider";
import type { Env } from "../env";
import type { SessionActivity, SessionStatus } from "@forge/domain";

/** RPC shape of the DO the loop drives. */
interface AgentDOStub {
  transitionTo(
    to: { status?: SessionStatus; activity?: SessionActivity | null },
    reason: string,
  ): Promise<{ to: { status: SessionStatus } }>;
  reportStatus(s: { activity?: SessionActivity; summary?: string }): Promise<void>;
  requestHumanInput(q: string): Promise<void>;
  createArtifact(a: {
    type: string;
    storageUri: string;
    generatedBy: string;
  }): Promise<{ artifactId: string }>;
  completePR(c: { diffSummary: string; commitSha: string }): Promise<void>;
  getStatus(): Promise<{ status: SessionStatus; activity: SessionActivity | null }>;
  getRepoId(): Promise<{ repoId: string }>;
}

/** A sandbox handle stored from provisioning (used for exec + verification). */
interface SandboxHandleLite {
  id: string;
  workdir: string;
  imageVersion: string;
}

/**
 * Run one agent turn. In `real` mode: provisions a sandbox, boots OpenCode,
 * parses the event stream. In `fast` mode: consumes the mock model stream.
 * Both modes translate events into DO transitions (docs/11 §3).
 */
export async function runAgentTurn(opts: {
  sessionId: string;
  prompt: string;
  model: ModelProvider;
  sandbox: SandboxProvider;
  env: Env;
}): Promise<{ finalStatus: SessionStatus }> {
  const stub = opts.env.sessionDo.idFromName(opts.sessionId);
  const doStub = opts.env.sessionDo.get(stub) as unknown as AgentDOStub;

  const current = await doStub.getStatus();
  if (current.status === "queued") {
    await doStub
      .transitionTo({ status: "active", activity: "provisioning" }, "agent_activate")
      .catch(() => {});
  }

  // Try the real sandbox path (provision + OpenCode subprocess). If it fails
  // (no sandbox binding, or provisioning error), fall back to the model stream
  // path (the mock model or a direct AI Gateway call without a harness).
  let sandboxHandle: SandboxHandleLite | null = null;
  try {
    const { repoId } = await doStub.getRepoId();
    const handle = await opts.sandbox.provision({
      repoId,
      imageVersion: "latest",
      gitIdentity: { name: "forge-agent", email: "forge@noreply.example.com" },
    });
    sandboxHandle = { id: handle.id, workdir: handle.workdir, imageVersion: handle.imageVersion };
  } catch {
    // No sandbox available — fall through to direct model stream mode.
  }

  if (sandboxHandle && opts.env.SANDBOX_DO) {
    // Real mode: run OpenCode in the sandbox.
    return runOpenCodeInSandbox(opts, doStub, sandboxHandle);
  }

  // Fast/fallback mode: stream the model directly (mock or AI Gateway).
  return runModelStream(opts, doStub);
}

/**
 * Real mode: run OpenCode as a subprocess inside the CF Sandbox.
 * Uses `sandbox.exec(handle, command)` to run OpenCode non-interactively.
 * The forge.* tools are available via the MCP server (configured in .opencode.json).
 * OpenCode makes MCP tool calls back to /api/mcp, which transitions the DO.
 */
async function runOpenCodeInSandbox(
  opts: { sessionId: string; prompt: string; sandbox: SandboxProvider; env: Env },
  doStub: AgentDOStub,
  handle: SandboxHandleLite,
): Promise<{ finalStatus: SessionStatus }> {
  const modelName = opts.env.AI_GATEWAY_MODEL ?? "grok-4.3";
  // Use the custom "forge-gateway" provider (configured in .opencode.json to
  // route through the AI Gateway) instead of the native provider prefix.
  const modelFlag = `forge-gateway/${modelName}`;

  await doStub.reportStatus({ activity: "running", summary: "OpenCode booting" }).catch(() => {});

  try {
    // Run OpenCode non-interactively with JSON output. The forge.* tools are
    // available via the MCP server (configured in .opencode.json written at
    // provision time). OpenCode calls them via JSON-RPC to /api/mcp.
    //
    // The prompt is passed as an argument; OpenCode handles the edit-test loop
    // internally. We capture the exit code + output.
    const escapedPrompt = opts.prompt.replace(/'/g, "'\\''");
    const result = await opts.sandbox.exec(
      handle,
      ["opencode", "run", "--format", "json", "-m", modelFlag, escapedPrompt],
      { sessionId: opts.sessionId },
    );

    // If OpenCode finished but didn't call forge.completePR (the session is
    // still active/running), mark as no_change.
    if (result.exitCode === 0) {
      const status = await doStub.getStatus();
      if (status.status === "active") {
        await doStub.transitionTo({ status: "no_change" }, "agent_no_change").catch(() => {});
      }
    } else {
      // Non-zero exit — the agent errored.
      console.error("[agent] OpenCode exit", result.exitCode, result.stderr.slice(0, 200));
      await doStub.transitionTo({ status: "failed" }, "agent_execution_error").catch(() => {});
    }
  } catch (err) {
    console.error(
      "[agent] OpenCode execution failed:",
      err instanceof Error ? err.message : String(err),
    );
    await doStub.transitionTo({ status: "failed" }, "agent_execution_error").catch(() => {});
  }

  const status = await doStub.getStatus();
  return { finalStatus: status.status };
}

/**
 * Fast/fallback mode: stream the model directly and translate events.
 * Used when no sandbox is available (mock model for tests, or direct model
 * stream without the OpenCode harness).
 */
async function runModelStream(
  opts: { sessionId: string; prompt: string; model: ModelProvider },
  doStub: AgentDOStub,
): Promise<{ finalStatus: SessionStatus }> {
  let markedRunning = false;
  const modelName = "grok-4.3";

  for await (const event of opts.model.stream({ prompt: opts.prompt, model: modelName })) {
    if (!markedRunning && (event.type === "thinking_delta" || event.type === "tool_call")) {
      await doStub.reportStatus({ activity: "running", summary: "agent started" }).catch(() => {});
      markedRunning = true;
    }

    switch (event.type) {
      case "thinking_delta":
        break;
      case "tool_call": {
        // In the real model, forge.* tool calls arrive as tool_call events.
        // Route them to the DO. args is already a parsed object.
        const args = typeof event.args === "string" ? JSON.parse(event.args) : event.args;
        if (event.toolName === "forge.reportStatus") {
          await doStub
            .reportStatus(args as { activity?: SessionActivity; summary?: string })
            .catch(() => {});
        } else if (event.toolName === "forge.requestHumanInput") {
          await doStub
            .requestHumanInput((args as { question?: string }).question ?? "")
            .catch(() => {});
        } else if (event.toolName === "forge.completePR") {
          await doStub
            .completePR({
              diffSummary: (args as { diffSummary?: string }).diffSummary ?? "",
              commitSha: (args as { commitSha?: string }).commitSha ?? "",
            })
            .catch(() => {});
        }
        break;
      }
      case "request_human_input":
        await doStub.requestHumanInput(event.question);
        break;
      case "complete_pr":
        await doStub.completePR({ diffSummary: event.diffSummary, commitSha: event.commitSha });
        break;
      case "finish":
        break;
    }
  }

  const status = await doStub.getStatus();
  return { finalStatus: status.status };
}

/** Collect a model stream into an event array (for tests / replay). */
export async function collectModelEvents(
  model: ModelProvider,
  prompt: string,
): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of model.stream({ prompt, model: "mock" })) out.push(e);
  return out;
}

/** Harness config shape (written to the sandbox as .opencode.json). */
export interface HarnessConfig {
  platformMcpEndpoint: string;
  registryAllowlist: string[];
}

/** Build the harness config for a session (used by the sandbox provider). */
export function buildHarnessConfig(opts: {
  workerOrigin: string;
  registryAllowlist?: string[];
}): HarnessConfig {
  return {
    platformMcpEndpoint: `${opts.workerOrigin}/api/mcp`,
    registryAllowlist: opts.registryAllowlist ?? [],
  };
}
