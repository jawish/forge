// CF Sandbox SDK provider — the real sandbox backed by Cloudflare Containers
// (docs/08 §3, checklist §6.3). Uses @cloudflare/sandbox which provides exec,
// files, git, processes, backup, and tunnels on top of CF Containers.
//
// The Sandbox SDK DO (class Sandbox from @cloudflare/sandbox) owns the container
// lifecycle. This provider uses getSandbox() to get/create a sandbox instance,
// then drives it via the SandboxClient API (commands.exec, files.write, etc.).

import type {
  BackgroundProcess,
  ExecResult,
  ExecOptions,
  ProcessStatus,
  ProvisionSpec,
  SandboxHandle,
  SandboxProvider,
  SnapshotRef,
} from "./provider";

/** The CF Sandbox SDK config (from the dev-shared / prod secret binding). */
export interface SandboxSdkConfig {
  /** sleepAfter: how long before idle sandboxes auto-sleep (default 10m). */
  sleepAfter?: string;
  /** Git identity for commits. */
  gitName: string;
  gitEmail: string;
  /** The repo clone URL (e.g., https://github.com/org/repo.git). */
  repoCloneUrl?: string;
  /** GitHub token for git push (if pushing branches). */
  githubToken?: string;
  /** Model API key for OpenCode (passed into the sandbox as an env var). */
  modelApiKey?: string;
  /** Model provider for OpenCode (e.g., "anthropic", "openai", "xai"). */
  modelProvider?: string;
  /** The model ID OpenCode should use (e.g., "claude-sonnet-4-5", "grok-4.3"). */
  modelId?: string;
  /** The forge MCP endpoint URL (the worker's origin + /api/mcp). */
  forgeMcpEndpoint?: string;
}

/** A handle to a provisioned CF Sandbox. */
export interface SandboxSdkHandle extends SandboxHandle {
  sandboxId: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let SandboxMod: any = null;

async function ensureSandboxMod(): Promise<typeof import("@cloudflare/sandbox")> {
  if (SandboxMod) return SandboxMod;
  SandboxMod = await import("@cloudflare/sandbox");
  return SandboxMod;
}

/**
 * Build the environment variables to pass into the sandbox for OpenCode.
 * These are set on each exec() call so OpenCode can authenticate with the
 * model provider + reach the forge MCP server.
 */
export function buildSandboxEnv(cfg: SandboxSdkConfig, sessionId: string): Record<string, string> {
  const env: Record<string, string> = {
    // OpenCode needs to know the session ID so it can pass it to forge.* MCP tools.
    FORGE_SESSION_ID: sessionId,
    // The forge MCP endpoint (OpenCode connects to this for forge.reportStatus etc.)
    FORGE_MCP_ENDPOINT: cfg.forgeMcpEndpoint ?? "",
  };

  // Pass the model API key under the provider-specific env var name.
  // OpenCode reads these from the environment to authenticate.
  if (cfg.modelApiKey) {
    const providerKey = modelEnvVarName(cfg.modelProvider ?? "xai");
    env[providerKey] = cfg.modelApiKey;
  }

  return env;
}

/** Map a provider name to the env var OpenCode expects. */
function modelEnvVarName(provider: string): string {
  switch (provider.toLowerCase()) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "xai":
      return "XAI_API_KEY";
    case "google":
    case "gemini":
      return "GEMINI_API_KEY";
    default:
      return "OPENAI_API_KEY"; // fallback
  }
}

/**
 * The Sandbox SDK provider. Uses @cloudflare/sandbox's getSandbox() to manage
 * container lifecycle. Each session gets its own sandbox (addressed by session ID).
 */
export class SandboxSdkProvider implements SandboxProvider {
  private readonly cfg: SandboxSdkConfig;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly sandboxNs: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(cfg: SandboxSdkConfig, sandboxNs: any) {
    this.cfg = cfg;
    this.sandboxNs = sandboxNs;
  }

  private async getSandboxClient(sandboxId: string) {
    const mod = await ensureSandboxMod();
    // getSandbox() returns a Sandbox client object with .commands, .files,
    // .processes, etc. directly accessible (they make HTTP requests to the
    // Sandbox DO internally). We do NOT access .client — that's an internal
    // DO property not available via RPC from outside the DO.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return mod.getSandbox(this.sandboxNs, sandboxId, {
      sleepAfter: this.cfg.sleepAfter ?? "10m",
    });
  }

  async provision(spec: ProvisionSpec): Promise<SandboxSdkHandle> {
    // Sandbox IDs must be 1-63 chars, lowercase. Use a short hash.
    const sandboxId = `sb-${Date.now().toString(36)}-${spec.repoId.slice(0, 10)}`.toLowerCase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sandbox: any = await this.getSandboxClient(sandboxId);

    // Clone the repo into /workspace.
    if (this.cfg.repoCloneUrl) {
      const cloneUrl = this.cfg.githubToken
        ? this.cfg.repoCloneUrl.replace("https://", `https://${this.cfg.githubToken}@`)
        : this.cfg.repoCloneUrl;
      await sandbox.exec(`git clone ${cloneUrl} /workspace || true`);
    }

    // Set up git identity.
    await sandbox.exec(
      `cd /workspace && git config user.name "${this.cfg.gitName}" && git config user.email "${this.cfg.gitEmail}"`,
    );

    // Create the working branch.
    const branchName = `forge/${spec.repoId}/${Date.now()}`;
    await sandbox.exec(`cd /workspace && git checkout -b "${branchName}"`);

    // Write the OpenCode config (model + MCP).
    await this.writeOpenCodeConfig(sandbox);

    return {
      id: sandboxId,
      sandboxId,
      workdir: "/workspace",
      imageVersion: spec.imageVersion,
    };
  }

  async exec(handle: SandboxHandle, command: string[], opts?: ExecOptions): Promise<ExecResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sandbox: any = await this.getSandboxClient(
      (handle as { sandboxId?: string }).sandboxId ?? handle.id,
    );
    const started = Date.now();
    const cmd = command.join(" ");
    const execOpts: { cwd: string; env?: Record<string, string> } = { cwd: "/workspace" };
    if (opts?.sessionId) {
      execOpts.env = buildSandboxEnv(this.cfg, opts.sessionId);
    }
    const result = await sandbox.exec(cmd, execOpts);
    return {
      exitCode: result.exitCode ?? (result.success ? 0 : 1),
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      durationMs: Date.now() - started,
    };
  }

  /**
   * Start a long-running background process in the sandbox (non-blocking).
   * Returns immediately with a process ID. Use getProcessStatus() to poll.
   * Used for running OpenCode (which can take minutes) without blocking the
   * Worker's request lifecycle.
   */
  async startBackground(
    handle: SandboxHandle,
    command: string[],
    opts?: ExecOptions,
  ): Promise<BackgroundProcess> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sandbox: any = await this.getSandboxClient(
      (handle as { sandboxId?: string }).sandboxId ?? handle.id,
    );
    const cmd = command.join(" ");
    const startOpts: { cwd: string; env?: Record<string, string> } = { cwd: "/workspace" };
    if (opts?.sessionId) {
      startOpts.env = buildSandboxEnv(this.cfg, opts.sessionId);
    }
    const process = await sandbox.startProcess(cmd, startOpts);
    return { processId: process.id };
  }

  /**
   * Check the status of a background process. Returns whether it exited +
   * captured output. Used by the DO alarm to poll whether OpenCode finished.
   */
  async getProcessStatus(handle: SandboxHandle, processId: string): Promise<ProcessStatus> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sandbox: any = await this.getSandboxClient(
      (handle as { sandboxId?: string }).sandboxId ?? handle.id,
    );
    const proc = await sandbox.getProcess(processId);
    const logs = await sandbox.getProcessLogs(processId).catch(() => ({ stdout: "", stderr: "" }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = proc as any;
    return {
      exited: p?.status === "exited" || p?.status === "completed",
      exitCode: p?.exitCode,
      stdout: logs.stdout ?? "",
      stderr: logs.stderr ?? "",
    };
  }

  async snapshot(_handle: SandboxHandle): Promise<SnapshotRef> {
    // Backup API not available via RPC from outside the DO (Phase 2).
    return {
      id: `snap-${Date.now()}`,
      location: "cf-sandbox-backup://pending",
      takenAt: Date.now(),
    };
  }

  async restore(_ref: SnapshotRef, spec: ProvisionSpec): Promise<SandboxSdkHandle> {
    const sandboxId = `forge-${spec.repoId}-restored-${Date.now()}`;
    return { id: sandboxId, sandboxId, workdir: "/workspace", imageVersion: spec.imageVersion };
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sandbox: any = await this.getSandboxClient(
      (handle as { sandboxId?: string }).sandboxId ?? handle.id,
    );
    await sandbox.destroy();
  }

  /** Write the OpenCode config into the sandbox (model + MCP settings). */
  private async writeOpenCodeConfig(sandbox: unknown): Promise<void> {
    // The .opencode.json config sets up the forge MCP server.
    // The model API key is passed via env var (XAI_API_KEY etc.) by buildSandboxEnv.
    // OpenCode uses its built-in provider routing (e.g., -m xai/grok-4.3).
    const config: Record<string, unknown> = {
      $schema: "https://opencode.ai/config.json",
    };

    if (this.cfg.forgeMcpEndpoint) {
      config.mcp = {
        forge: {
          type: "remote",
          url: this.cfg.forgeMcpEndpoint,
        },
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = sandbox as any;
    await sb.writeFile("/workspace/.opencode.json", JSON.stringify(config, null, 2));
  }
}
