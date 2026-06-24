// CloudflareSandboxProvider — the real-profile + prod sandbox (docs/08 §3,
// checklist §6.3). CF Containers (GA June 2025) are managed via Durable Object
// Container API, NOT a standalone REST endpoint. The lifecycle:
//
// 1. A Container-enabled DO subclass (CloudflareSandboxContainer) holds the
//    container handle and manages start/stop via this.ctx.container.
// 2. The control plane routes requests to the DO, which starts the container
//    image on demand (cold start) and keeps it warm via sleepAfter.
// 3. Snapshots use the DO's container.getBackup() / restoreFromBackup()
//    API (the Backups API from docs/08 §3).
//
// This provider is the control-plane-side orchestrator: it creates/addresses
// the sandbox DO, which in turn manages the container. The actual container
// start/stop happens inside the DO (docs/19 §4 — the harness loop runs there).

import type {
  ExecResult,
  ProvisionSpec,
  SandboxHandle,
  SandboxProvider,
  SnapshotRef,
} from "./provider";

/** CF Containers config (from the dev-shared / prod secret binding). */
export interface CloudflareSandboxConfig {
  /** The CF account id (containers live under the account). */
  accountId: string;
  /** API token with Containers permissions. */
  apiToken: string;
  /** Default region hint (containers are single-PoP, docs/08 §3). */
  region?: string;
  /** sleepAfter override (default 10 min, docs/08 §3). */
  sleepAfterMinutes?: number;
}

/**
 * Cloudflare Sandbox provider. One Container-backed DO per session; the DO
 * manages the container lifecycle (start/snapshot/restore) via the Container
 * API. Exec runs inside the DO (the container's shell). Credential injection
 * happens at the Outbound Workers boundary (docs/18 §5), not here — the
 * provider never holds session-user creds.
 *
 * This provider delegates to a CloudflareSandboxContainer DO (the DO subclass
 * that extends @cloudflare/containers Container). The provider addresses the DO
 * by session id and calls RPC methods on it.
 */
export class CloudflareSandboxProvider implements SandboxProvider {
  private readonly cfg: CloudflareSandboxConfig;
  private readonly sandboxDO: DurableObjectNamespace;

  constructor(cfg: CloudflareSandboxConfig, sandboxDO: DurableObjectNamespace) {
    this.cfg = cfg;
    this.sandboxDO = sandboxDO;
  }

  async provision(spec: ProvisionSpec): Promise<SandboxHandle> {
    // Address a sandbox DO by the repo+image composite name. The DO starts the
    // container on first access (cold start). sleepAfter keeps it warm.
    const doName = `${spec.repoId}:${spec.imageVersion}`;
    const id = this.sandboxDO.idFromName(doName);
    const stub = this.sandboxDO.get(id) as unknown as SandboxDOStub;
    const result = await stub.start({
      image: spec.imageVersion,
      env: {
        GIT_AUTHOR_NAME: spec.gitIdentity.name,
        GIT_AUTHOR_EMAIL: spec.gitIdentity.email,
        GIT_COMMITTER_NAME: spec.gitIdentity.name,
        GIT_COMMITTER_EMAIL: spec.gitIdentity.email,
      },
      sleepAfter: (this.cfg.sleepAfterMinutes ?? 10) * 60,
      region: this.cfg.region,
      egress: spec.egressAllow ?? [],
    });
    return {
      id: result.containerId,
      workdir: "/workspace",
      imageVersion: spec.imageVersion,
    };
  }

  async exec(handle: SandboxHandle, command: string[]): Promise<ExecResult> {
    const id = this.sandboxDO.idFromName(handle.id);
    const stub = this.sandboxDO.get(id) as unknown as SandboxDOStub;
    const started = Date.now();
    const result = await stub.exec({ command });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - started,
    };
  }

  async snapshot(handle: SandboxHandle): Promise<SnapshotRef> {
    const id = this.sandboxDO.idFromName(handle.id);
    const stub = this.sandboxDO.get(id) as unknown as SandboxDOStub;
    const result = await stub.createBackup();
    return {
      id: result.backupId,
      location: `cf-container-backup://${this.cfg.accountId}/${result.backupId}`,
      takenAt: Date.now(),
    };
  }

  async restore(ref: SnapshotRef, spec: ProvisionSpec): Promise<SandboxHandle> {
    // Restore: create a new sandbox DO from the backup (copy-on-write overlay).
    const doName = `${spec.repoId}:${spec.imageVersion}:restored:${ref.id}`;
    const id = this.sandboxDO.idFromName(doName);
    const stub = this.sandboxDO.get(id) as unknown as SandboxDOStub;
    const result = await stub.restoreFromBackup(ref.id, spec.imageVersion);
    return {
      id: result.containerId,
      workdir: "/workspace",
      imageVersion: spec.imageVersion,
    };
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const id = this.sandboxDO.idFromName(handle.id);
    const stub = this.sandboxDO.get(id) as unknown as SandboxDOStub;
    await stub.stop();
  }
}

/** The RPC interface the CloudflareSandboxContainer DO exposes. */
export interface SandboxDOStub {
  start(opts: {
    image: string;
    env: Record<string, string>;
    sleepAfter: number;
    region?: string;
    egress: string[];
  }): Promise<{ containerId: string }>;
  exec(opts: { command: string[] }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  createBackup(): Promise<{ backupId: string }>;
  restoreFromBackup(backupId: string, image: string): Promise<{ containerId: string }>;
  stop(): Promise<void>;
}
