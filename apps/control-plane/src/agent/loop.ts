// Agent harness — drives the agent loop (docs/19 §7 configure-don't-fork, §5.21–5.22).
// At spawn, an OpenCode MCP-consumer config is written (§5.20) listing the platform
// MCP endpoint + registry allowlist (empty for now). In `fast`, the "harness" is
// the MockModelProvider driving the loop; in `real` (§6) it's real OpenCode.
//
// The loop: model streams events → harness translates them into DO transitions
// + platform-MCP calls → DO reaches a terminal/ready state (docs/11 §3).

import type { ModelEvent, ModelProvider } from "../model/provider";
import type { SandboxProvider } from "../sandbox/provider";
import type { Env } from "../env";
import type { SessionActivity, SessionStatus } from "@forge/domain";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

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

/**
 * Run one agent turn: stream model events for the prompt, translate each event
 * into the matching DO mutation (docs/11 §3, docs/10 §6). Drives the session
 * toward ready_for_pr / awaiting_input / no_change based on the model's events.
 *
 * §5.19: on first activation, provision the sandbox (git identity + workdir) +
 * write the OpenCode MCP-consumer config (§5.20).
 * §5.21: the harness is "booted" pointed at the MCP-consumer config.
 * §5.22: the loop drives transitions — model streams thinking → harness calls
 * tools → forge.reportStatus/completePR arrive → DO transitions accordingly.
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

  // Activate + provision the session on first prompt (docs/11 §3: queued → active).
  // Spawn leaves the session in queued; the first prompt transitions to active
  // (provisioning), provisions the sandbox, writes the MCP config, then runs the
  // model stream. Idempotent if the session is already active.
  const current = await doStub.getStatus();
  if (current.status === "queued") {
    await doStub
      .transitionTo({ status: "active", activity: "provisioning" }, "agent_activate")
      .catch(() => {});

    // §5.19: provision the sandbox (git identity + fresh workdir via the provider).
    // §5.20: write the OpenCode MCP-consumer config into the sandbox workdir.
    try {
      const { repoId } = await doStub.getRepoId();
      const handle = await opts.sandbox.provision({
        repoId,
        imageVersion: "latest",
        gitIdentity: { name: "forge-agent", email: "forge@noreply.example.com" },
      });
      const config = buildHarnessConfig({
        workerOrigin: opts.env.WORKER_ORIGIN ?? "http://localhost:8787",
      });
      await writeMcpConfig(handle.workdir, config);
      // Mark provisioning done → running happens on the first thinking event below.
    } catch {
      // Provisioning failure is non-fatal in the fast profile (the mock model
      // can still drive the loop). In the real profile (§6) this would transition
      // to failed. Kept lenient so the loop is runnable without a real sandbox.
    }
  }

  // Provisioning -> running (the harness "starts" — first thinking event).
  let markedRunning = false;
  const modelName = opts.env.AI_GATEWAY_MODEL ?? "grok-4.3";

  for await (const event of opts.model.stream({ prompt: opts.prompt, model: modelName })) {
    if (!markedRunning && (event.type === "thinking_delta" || event.type === "tool_call")) {
      await doStub.reportStatus({ activity: "running", summary: "agent started" }).catch(() => {});
      markedRunning = true;
    }

    switch (event.type) {
      case "thinking_delta":
        // UI streams the delta (§5.12); no DO mutation needed here.
        break;
      case "tool_call":
        // Tool calls are recorded by the harness/tool layer; the platform MCPs
        // (forge.*) are called by the agent itself. No-op here for non-platform tools.
        break;
      case "request_human_input":
        // Agent asked a clarifying question → activity=awaiting_input.
        await doStub.requestHumanInput(event.question);
        break;
      case "complete_pr":
        // Agent signals readiness → status=ready_for_pr, activity=null.
        await doStub.completePR({ diffSummary: event.diffSummary, commitSha: event.commitSha });
        break;
      case "finish":
        // If the model finished without complete_pr/request_input, the session
        // stays active (running) — the agent may have more turns. Phase 0 mock
        // fixtures end via complete_pr or request_human_input.
        break;
    }
  }

  const status = await doStub.getStatus();
  return { finalStatus: status.status };
}

/**
 * Spawn-time harness config (§5.20): writes an OpenCode MCP-consumer config to
 * the sandbox listing the platform MCP endpoint + registry allowlist. In `fast`
 * the "sandbox" is a local workdir; in `real` (§6) it's the CF Sandbox. No
 * OpenCode fork — just config (docs/19 §7).
 */
export interface HarnessConfig {
  platformMcpEndpoint: string;
  registryAllowlist: string[];
}

/** Build the harness config for a session (written to the sandbox at spawn). */
export function buildHarnessConfig(opts: {
  workerOrigin: string;
  registryAllowlist?: string[];
}): HarnessConfig {
  return {
    platformMcpEndpoint: `${opts.workerOrigin}/api/mcp`,
    // Empty registry allowlist for now (registry-managed MCP governance is §9/ADR-0007).
    registryAllowlist: opts.registryAllowlist ?? [],
  };
}

/**
 * Write the OpenCode MCP-consumer config to the sandbox workdir (§5.20).
 * The config lists the platform MCP endpoint + the registry allowlist. OpenCode
 * reads this at boot and exposes the forge.* tools to the model. No fork — just
 * config (docs/19 §7). In the fast profile the mock model doesn't read this, but
 * the file is written so the path is exercised + the real harness can find it.
 */
export async function writeMcpConfig(workdir: string, config: HarnessConfig): Promise<void> {
  const mcpConfig = {
    mcpServers: {
      forge: {
        url: config.platformMcpEndpoint,
      },
    },
    registryAllowlist: config.registryAllowlist,
  };
  await writeFile(join(workdir, ".forge-mcp.json"), JSON.stringify(mcpConfig, null, 2), "utf8");
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
