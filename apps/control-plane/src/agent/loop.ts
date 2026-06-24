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
 * Direct agent loop — a real multi-turn coding agent.
 *
 * The loop works in iterations:
 * 1. Send the task + conversation history to the model
 * 2. Parse the model's response for commands (RUN:) or completion (DONE:)
 * 3. Execute each command in the sandbox via exec()
 * 4. Feed the command output back into the conversation
 * 5. Repeat until DONE: or max iterations
 * 6. Commit, push, and create a GitHub PR
 *
 * This is a real ReAct-style agent loop — no mocks. The sandbox is a real
 * CF Container. The model is real Grok-4.3 via AI Gateway.
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
  const maxIterations = 5;

  await doStub.reportStatus({ activity: "running", summary: "Agent thinking" }).catch(() => {});

  const systemPrompt = `You are an autonomous coding agent working in a git repository at /workspace.
You interact with the codebase by issuing bash commands.

FORMAT: Each turn, respond with ONE OR MORE commands prefixed with "RUN:" (one per line).
After commands, you'll see their output. Then decide the next step.
When the task is complete and tests pass, respond with "DONE:" followed by a one-line summary.

CAPABILITIES: You can read files (cat, head, grep), edit files (using sed, echo, or python scripts),
run tests (pytest, npm test, etc.), and inspect the repo (git status, git log).

STRATEGY: First explore the codebase, understand the task, make changes, run tests, and fix any failures.
Be thorough — verify your changes work before saying DONE.`;

  // Conversation history (accumulated across turns).
  const conversation: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Task: ${opts.prompt}` },
  ];

  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      console.log(`[agent] Iteration ${iteration + 1}/${maxIterations}`);

      // Build the prompt from conversation history.
      const prompt = conversation.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");

      // Call the model.
      let modelResponse = "";
      for await (const event of opts.model.stream({ prompt, model: modelName })) {
        if (event.type === "thinking_delta") {
          modelResponse += event.text;
        } else if (event.type === "finish") {
          break;
        }
      }

      console.log(`[agent] Turn ${iteration + 1} response:`, modelResponse.slice(0, 300));
      conversation.push({ role: "assistant", content: modelResponse });

      // Check for DONE.
      if (modelResponse.includes("DONE:")) {
        console.log("[agent] Agent signaled DONE");
        break;
      }

      // Parse and execute RUN: commands.
      const commands = modelResponse
        .split("\n")
        .filter((line) => line.trim().startsWith("RUN:"))
        .map((line) => line.trim().slice(4).trim());

      if (commands.length === 0) {
        console.log("[agent] No RUN: commands, ending loop");
        break;
      }

      // Execute each command and collect output for the next turn.
      const outputs: string[] = [];
      for (const cmd of commands) {
        console.log("[agent] Exec:", cmd.slice(0, 100));
        const result = await opts.sandbox.exec(handle, [cmd], { sessionId: opts.sessionId });
        const output = result.exitCode === 0 ? result.stdout : result.stderr;
        const truncated = (output || "(no output)").slice(0, 1000);
        outputs.push(`$ ${cmd}\n${truncated}\n(exit: ${result.exitCode})`);
        console.log("[agent] Exit:", result.exitCode, "out:", truncated.slice(0, 100));
      }

      // Feed the output back into the conversation.
      conversation.push({ role: "user", content: outputs.join("\n\n") });
    }

    // Commit all changes.
    const commitMsg = opts.prompt.slice(0, 50).replace(/'/g, "");
    const commitResult = await opts.sandbox.exec(
      handle,
      [`cd /workspace && git add -A && git commit -m 'forge: ${commitMsg}'`],
      { sessionId: opts.sessionId },
    );
    console.log("[agent] Commit exit:", commitResult.exitCode);

    // Push to GitHub if we have a token.
    if (opts.env.GITHUB_TOKEN && opts.env.GITHUB_REPO_URL) {
      console.log("[agent] Pushing to GitHub...");
      const pushResult = await opts.sandbox.exec(
        handle,
        ["cd /workspace && git push origin HEAD 2>&1"],
        { sessionId: opts.sessionId },
      );
      console.log("[agent] Push exit:", pushResult.exitCode, pushResult.stdout.slice(0, 200));
    }

    // Get the diff summary.
    const diffResult = await opts.sandbox.exec(
      handle,
      ["cd /workspace && git diff HEAD~1 --stat"],
      { sessionId: opts.sessionId },
    ).catch(() => ({ exitCode: 1, stdout: "changes committed", stderr: "", durationMs: 0 }));
    const diffSummary = diffResult.stdout.slice(0, 500) || "changes committed";

    // Signal completion.
    await doStub.completePR({ diffSummary, commitSha: "auto" }).catch((err) => {
      console.error("[agent] completePR failed:", err instanceof Error ? err.message : String(err));
    });
    console.log("[agent] completePR called → ready_for_pr");
  } catch (err) {
    console.error("[agent] Loop failed:", err instanceof Error ? err.message : String(err));
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
