// CF Sandbox SDK provider — the real sandbox backed by Cloudflare Containers
// (docs/08 §3, checklist §6.3). Uses @cloudflare/sandbox which provides exec,
// files, git, processes, backup, and tunnels on top of CF Containers.
//
// The Sandbox SDK DO (class Sandbox from @cloudflare/sandbox) owns the container
// lifecycle. This provider uses getSandbox() to get/create a sandbox instance,
// then drives it via the SandboxClient API (commands.exec, files.write, etc.).

import type {
  ExecResult,
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sandbox: any = mod.getSandbox(this.sandboxNs, sandboxId, {
      sleepAfter: this.cfg.sleepAfter ?? "10m",
    });
    return sandbox.client ?? sandbox;
  }

  async provision(spec: ProvisionSpec): Promise<SandboxSdkHandle> {
    const sandboxId = `forge-${spec.repoId}-${Date.now()}`;
    const sandbox = await this.getSandboxClient(sandboxId);

    // Clone the repo into /workspace.
    if (this.cfg.repoCloneUrl) {
      const cloneUrl = this.cfg.githubToken
        ? this.cfg.repoCloneUrl.replace("https://", `https://${this.cfg.githubToken}@`)
        : this.cfg.repoCloneUrl;
      await sandbox.commands.exec(`git clone ${cloneUrl} /workspace || true`);
    }

    // Set up git identity.
    await sandbox.commands.exec(
      `cd /workspace && git config user.name "${this.cfg.gitName}" && git config user.email "${this.cfg.gitEmail}"`,
    );

    // Create the working branch.
    const branchName = `forge/${spec.repoId}/${Date.now()}`;
    await sandbox.commands.exec(`cd /workspace && git checkout -b "${branchName}"`);

    // Write the OpenCode config (model + MCP).
    await this.writeOpenCodeConfig(sandbox);

    return {
      id: sandboxId,
      sandboxId,
      workdir: "/workspace",
      imageVersion: spec.imageVersion,
    };
  }

  async exec(
    handle: SandboxHandle,
    command: string[],
    opts?: { sessionId?: string },
  ): Promise<ExecResult> {
    const sandbox = await this.getSandboxClient((handle as SandboxSdkHandle).sandboxId);
    const started = Date.now();
    const cmd = command.join(" ");
    // Pass model API keys + session ID into the command's environment.
    const execOpts: { cwd: string; env?: Record<string, string> } = { cwd: "/workspace" };
    if (opts?.sessionId) {
      execOpts.env = buildSandboxEnv(this.cfg, opts.sessionId);
    }
    const result = await sandbox.commands.exec(cmd, execOpts);
    return {
      exitCode: result.exitCode ?? (result.success ? 0 : 1),
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      durationMs: Date.now() - started,
    };
  }

  async snapshot(handle: SandboxHandle): Promise<SnapshotRef> {
    const sandbox = await this.getSandboxClient((handle as SandboxSdkHandle).sandboxId);
    const backup = await sandbox.backup.create();
    return { id: backup.id, location: `cf-sandbox-backup://${backup.id}`, takenAt: Date.now() };
  }

  async restore(ref: SnapshotRef, spec: ProvisionSpec): Promise<SandboxSdkHandle> {
    const sandboxId = `forge-${spec.repoId}-restored-${Date.now()}`;
    const sandbox = await this.getSandboxClient(sandboxId);
    await sandbox.backup.restore(ref.id);
    return { id: sandboxId, sandboxId, workdir: "/workspace", imageVersion: spec.imageVersion };
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const sandbox = await this.getSandboxClient((handle as SandboxSdkHandle).sandboxId);
    await sandbox.destroy();
  }

  /** Write the OpenCode config into the sandbox (model + MCP settings). */
  private async writeOpenCodeConfig(sandbox: unknown): Promise<void> {
    // The .opencode.json config sets up:
    // 1. The forge MCP server (for forge.reportStatus, forge.completePR, etc.)
    // 2. A custom OpenAI-compatible provider pointing at the AI Gateway
    //    (so the model calls route through the gateway for cost tracking/caching)
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

    // Configure a custom provider that routes through the CF AI Gateway.
    // The AI Gateway exposes an OpenAI-compatible endpoint per provider.
    // OpenCode reads the API key from the env var set by buildSandboxEnv().
    if (this.cfg.modelApiKey && this.cfg.modelProvider) {
      config.provider = {
        "forge-gateway": {
          name: "Forge AI Gateway",
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: `https://gateway.ai.cloudflare.com/v1/ad2ec34ab35ce8f5d899dd1363e876b3/forge-dev-gateway/${this.cfg.modelProvider}/v1`,
            apiKey: this.cfg.modelApiKey,
          },
          models: {
            [this.cfg.modelId ?? "grok-4.3"]: {
              name: this.cfg.modelId ?? "grok-4.3",
            },
          },
        },
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = sandbox as any;
    await sb.files.writeFile("/workspace/.opencode.json", JSON.stringify(config, null, 2));
  }
}
