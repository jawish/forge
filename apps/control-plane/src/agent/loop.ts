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
  setAgentProcess(input: { sandboxId: string; command: string }): Promise<void>;
}

/** A sandbox handle stored from provisioning (used for exec + verification). */
interface SandboxHandleLite {
  id: string;
  workdir: string;
  imageVersion: string;
  /** The CF Sandbox SDK sandbox ID (for re-acquiring the sandbox client). */
  sandboxId?: string;
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
    console.log("[agent] Provisioning sandbox for repo:", repoId);
    const handle = await opts.sandbox.provision({
      repoId,
      imageVersion: "latest",
      gitIdentity: { name: "forge-agent", email: "forge@noreply.example.com" },
    });
    sandboxHandle = {
      id: handle.id,
      workdir: handle.workdir,
      imageVersion: handle.imageVersion,
      sandboxId: (handle as { sandboxId?: string }).sandboxId ?? handle.id,
    };
    console.log("[agent] Sandbox provisioned:", handle.id);
  } catch (err) {
    console.error(
      "[agent] Sandbox provisioning failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  console.log(
    "[agent] sandboxHandle:",
    sandboxHandle ? "yes" : "no",
    "SANDBOX_DO:",
    opts.env.SANDBOX_DO ? "yes" : "no",
  );
  if (sandboxHandle && opts.env.SANDBOX_DO) {
    // Real mode: direct agent loop (model → sandbox exec → completePR).
    return runDirectAgentLoop(opts, doStub, sandboxHandle);
  }

  // Fast/fallback mode: stream the model directly (mock or AI Gateway).
  return runModelStream(opts, doStub);
}

/**
 * Direct agent loop — runs the model via AI Gateway and executes commands in
 * the sandbox via exec(). This is a real coding agent without the OpenCode
 * subprocess dependency:
 *
 * 1. Call the model with the prompt + system message describing available tools
 * 2. Parse the model's response for file write commands
 * 3. Execute writes via sandbox.exec("echo '...' > file")
 * 4. Run any test/build commands
 * 5. Call forge.completePR via the DO when done
 *
 * All real — no mocks. The sandbox is a real CF Container with the repo cloned.
 */
async function runDirectAgentLoop(
  opts: {
    sessionId: string;
    prompt: string;
    sandbox: SandboxProvider;
    env: Env;
    model: ModelProvider;
  },
  doStub: AgentDOStub,
  handle: SandboxHandleLite,
): Promise<{ finalStatus: SessionStatus }> {
  const modelName = opts.env.AI_GATEWAY_MODEL ?? "grok-4.3";
  const modelProvider = opts.env.AI_GATEWAY_PROVIDER ?? "xai";

  await doStub.reportStatus({ activity: "running", summary: "Agent thinking" }).catch(() => {});

  try {
    // Build a system prompt that instructs the model to respond with specific
    // tool-call format that we can parse and execute in the sandbox.
    const systemPrompt = `You are a coding agent working inside a repository at /workspace.
You have access to a bash shell. Respond with bash commands to accomplish the task.
Each command should be on its own line prefixed with "RUN:".
When you are done, respond with "DONE:" followed by a summary of what you changed.
Keep your response concise — just the commands and the DONE line.`;

    // Call the model via the AI Gateway.
    console.log("[agent] Calling model:", `${modelProvider}/${modelName}`);
    let modelResponse = "";
    for await (const event of opts.model.stream({
      prompt: `${systemPrompt}\n\nTask: ${opts.prompt}`,
      model: modelName,
    })) {
      if (event.type === "thinking_delta") {
        modelResponse += event.text;
      } else if (event.type === "finish") {
        break;
      }
    }

    console.log("[agent] Model response (first 500):", modelResponse.slice(0, 500));

    // Parse the model's response for RUN: commands.
    const commands = modelResponse
      .split("\n")
      .filter((line) => line.trim().startsWith("RUN:"))
      .map((line) => line.trim().slice(4).trim());

    console.log("[agent] Parsed", commands.length, "commands from model response");

    // Execute each command in the sandbox.
    for (const cmd of commands) {
      console.log("[agent] Executing:", cmd.slice(0, 100));
      const result = await opts.sandbox.exec(handle, [cmd], { sessionId: opts.sessionId });
      console.log("[agent] Exit:", result.exitCode, "stdout:", result.stdout.slice(0, 100));
      if (result.exitCode !== 0) {
        console.error("[agent] Command failed:", result.stderr.slice(0, 200));
      }
    }

    // Check if there are changes (git diff).
    const statusResult = await opts.sandbox.exec(
      handle,
      ["cd /workspace && git add -A && git status --porcelain"],
      {
        sessionId: opts.sessionId,
      },
    );
    const hasChanges = statusResult.exitCode === 0 && statusResult.stdout.trim().length > 0;
    console.log("[agent] git status:", statusResult.stdout.slice(0, 200));

    if (hasChanges) {
      // Get the diff summary.
      const diffSummary = statusResult.stdout.slice(0, 500);

      // Commit the changes.
      await opts.sandbox.exec(
        handle,
        ["cd /workspace && git add -A && git commit -m 'forge: " + opts.prompt.slice(0, 50) + "'"],
        { sessionId: opts.sessionId },
      );

      // Signal completion via the DO.
      await doStub.completePR({ diffSummary, commitSha: "auto" }).catch((err) => {
        console.error(
          "[agent] completePR failed:",
          err instanceof Error ? err.message : String(err),
        );
      });
      console.log("[agent] completePR called, session should transition to ready_for_pr");
    } else {
      // No changes — mark as no_change.
      await doStub.transitionTo({ status: "no_change" }, "agent_no_change").catch(() => {});
      console.log("[agent] No changes, transitioning to no_change");
    }
  } catch (err) {
    console.error("[agent] Direct loop failed:", err instanceof Error ? err.message : String(err));
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
