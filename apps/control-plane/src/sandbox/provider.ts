// The thin sandbox-provider interface (ADR-0001). The same interface is
// implemented by:
//   - LocalSandboxProvider   (fast profile: local subprocess — docs/09 §5)
//   - CloudflareSandboxProvider (real profile + prod: CF Sandbox — §6.3)
//   - (documented, not built) Daytona failover
//
// This earns its keep twice (local mock + failover); one-use abstractions are
// not allowed in this codebase (docs/07 §1.6). Keep it minimal.

/** Result of provisioning a sandbox. */
export interface SandboxHandle {
  /** Provider-specific sandbox id (1–63 chars for CF Sandbox, 08 §3). */
  id: string;
  /** Absolute path the sandbox is scoped to (the agent's workdir). */
  workdir: string;
  /** Image version the sandbox was provisioned from. */
  imageVersion: string;
}

/** The spec for a new sandbox. */
export interface ProvisionSpec {
  repoId: string;
  imageVersion: string;
  /** Git identity injected per-session (docs/10 §10 — no shared bot identity). */
  gitIdentity: { name: string; email: string };
  /** Egress allowlist from .forge/config.toml [egress] (docs/18 §5). */
  egressAllow?: string[];
}

/** Result of running a command in the sandbox. */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** A snapshot reference (for warm-pool restore). */
export interface SnapshotRef {
  id: string;
  /** Provider-specific location (R2 key, CF Backups API id, ...). */
  location: string;
  takenAt: number;
}

/**
 * The sandbox provider interface. All methods are async (network for CF Sandbox,
 * subprocess for Local). Implementations MUST enforce the egress allowlist
 * (deny-by-default) on exec — the boundary contract (docs/18 §5).
 */
export interface SandboxProvider {
  /** Boot a sandbox from an image version, scoped to a workdir. */
  provision(spec: ProvisionSpec): Promise<SandboxHandle>;
  /** Run a command in the sandbox (subject to the egress allowlist). */
  exec(handle: SandboxHandle, command: string[]): Promise<ExecResult>;
  /** Capture a filesystem snapshot (warm-pool / restore-before-reopen). */
  snapshot(handle: SandboxHandle): Promise<SnapshotRef>;
  /** Restore a sandbox from a snapshot (copy-on-write overlay). */
  restore(ref: SnapshotRef, spec: ProvisionSpec): Promise<SandboxHandle>;
  /** Tear down the sandbox (zeroize ephemeral state — docs/18 §6). */
  destroy(handle: SandboxHandle): Promise<void>;
}
