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

/** A handle to a provisioned CF Sandbox. Stores the sandbox ID so the provider
 * can re-acquire the sandbox client on subsequent calls. */
export interface SandboxSdkHandle extends SandboxHandle {
  /** The CF Sandbox SDK sandbox ID (used with getSandbox to re-acquire). */
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
    // getSandbox returns a Sandbox instance. Its .client property provides
    // commands, files, git, backup, etc. (the SandboxClient API).
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

    // Run prewarm commands if specified.
    if (spec.egressAllow) {
      for (const cmd of spec.egressAllow) {
        if (cmd.startsWith("prewarm:")) {
          await sandbox.commands.exec(cmd.slice(8)).catch(() => {});
        }
      }
    }

    return {
      id: sandboxId,
      sandboxId,
      workdir: "/workspace",
      imageVersion: spec.imageVersion,
    };
  }

  async exec(handle: SandboxHandle, command: string[]): Promise<ExecResult> {
    const sandbox = await this.getSandboxClient((handle as SandboxSdkHandle).sandboxId);
    const started = Date.now();
    const cmd = command.join(" ");
    const result = await sandbox.commands.exec(cmd, { cwd: "/workspace" });
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
    return {
      id: backup.id,
      location: `cf-sandbox-backup://${backup.id}`,
      takenAt: Date.now(),
    };
  }

  async restore(ref: SnapshotRef, spec: ProvisionSpec): Promise<SandboxSdkHandle> {
    const sandboxId = `forge-${spec.repoId}-restored-${Date.now()}`;
    const sandbox = await this.getSandboxClient(sandboxId);
    await sandbox.backup.restore(ref.id);
    return {
      id: sandboxId,
      sandboxId,
      workdir: "/workspace",
      imageVersion: spec.imageVersion,
    };
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const sandbox = await this.getSandboxClient((handle as SandboxSdkHandle).sandboxId);
    await sandbox.destroy();
  }

  /**
   * Write the OpenCode config into the sandbox. This configures:
   * - The model provider + API key (via env var, not in the config file)
   * - The forge MCP server (for reportStatus, completePR, etc.)
   */
  private async writeOpenCodeConfig(sandbox: unknown): Promise<void> {
    const config = {
      $schema: "https://opencode.ai/config.json",
      // The model is set via env var (modelApiKey + modelProvider) at boot.
      // OpenCode reads XAI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY from env.
      mcp: this.cfg.forgeMcpEndpoint
        ? {
            forge: {
              type: "remote",
              url: this.cfg.forgeMcpEndpoint,
            },
          }
        : {},
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = sandbox as any;
    await sb.files.writeFile("/workspace/.opencode.json", JSON.stringify(config, null, 2));
  }
}
