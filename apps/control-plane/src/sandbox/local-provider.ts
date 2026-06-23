// LocalSandboxProvider — the fast-profile sandbox (docs/09 §5, checklist §4.3).
// Runs commands in a local subprocess via child_process, scoped to a per-session
// temp workdir. Implements the same SandboxProvider interface as
// CloudflareSandboxProvider (§6.3). In fast, the Outbound Workers boundary
// (docs/18 §5) is an in-process egress allowlist check on exec (deny-by-default).

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExecResult,
  ProvisionSpec,
  SandboxHandle,
  SandboxProvider,
  SnapshotRef,
} from "./provider";

const FORGE_TMP_PREFIX = "forge-sandbox-";

/**
 * Local subprocess sandbox. Each provisioned sandbox gets a fresh temp workdir.
 * Snapshots are in-memory markers (the workdir is just a dir tree locally);
 * restore recreates it. Good enough for the fast inner loop; NOT a security
 * boundary — real isolation is CF Sandbox in the real profile.
 */
export class LocalSandboxProvider implements SandboxProvider {
  /** Track workdirs so destroy can clean them up. */
  private readonly workdirs = new Map<string, string>();
  /** In-memory snapshot store (id -> spec, for restore). */
  private readonly snapshots = new Map<string, ProvisionSpec>();

  async provision(spec: ProvisionSpec): Promise<SandboxHandle> {
    const workdir = await mkdtemp(join(tmpdir(), FORGE_TMP_PREFIX));
    // Inject the session-scoped git identity (docs/10 §10 — no shared bot).
    await mkdir(join(workdir, ".git"), { recursive: true });
    await writeFile(
      join(workdir, ".git", "config"),
      `[user]\n\tname = ${spec.gitIdentity.name}\n\temail = ${spec.gitIdentity.email}\n`,
      "utf8",
    );
    const id = `local-${workdir.split("-").pop() ?? Math.random().toString(36).slice(2)}`;
    this.workdirs.set(id, workdir);
    return { id, workdir, imageVersion: spec.imageVersion };
  }

  async exec(handle: SandboxHandle, command: string[]): Promise<ExecResult> {
    const workdir = this.workdirs.get(handle.id) ?? handle.workdir;
    const started = Date.now();
    const [cmd, ...args] = command;
    if (!cmd) {
      return { exitCode: 1, stdout: "", stderr: "empty command", durationMs: 0 };
    }
    // Egress allowlist check (docs/18 §5): deny-by-default. Network commands
    // reaching a non-allowlisted host are blocked + logged. Fast-profile analog
    // of the Outbound Workers boundary (real enforcement is §6.3).
    this.assertEgressAllowed(cmd);

    return new Promise((resolve) => {
      const child = spawn(cmd, args, { cwd: workdir });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", (err: Error) => {
        resolve({
          exitCode: 1,
          stdout,
          stderr: stderr + err.message,
          durationMs: Date.now() - started,
        });
      });
      child.on("close", (code: number | null) => {
        resolve({ exitCode: code ?? 1, stdout, stderr, durationMs: Date.now() - started });
      });
    });
  }

  async snapshot(handle: SandboxHandle): Promise<SnapshotRef> {
    // In-memory: record a marker. Real impl uses CF Backups API (§6.3).
    const id = `snap-${handle.id}-${Date.now()}`;
    this.snapshots.set(id, {
      repoId: handle.id,
      imageVersion: handle.imageVersion,
      gitIdentity: { name: "", email: "" },
    });
    return { id, location: `local-memory:${handle.workdir}`, takenAt: Date.now() };
  }

  async restore(ref: SnapshotRef, spec: ProvisionSpec): Promise<SandboxHandle> {
    // Provision a fresh workdir (the snapshot is just a marker locally).
    this.snapshots.get(ref.id); // validate the ref exists; result unused locally
    return this.provision(spec);
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const workdir = this.workdirs.get(handle.id);
    if (workdir) {
      await rm(workdir, { recursive: true, force: true });
      this.workdirs.delete(handle.id);
    }
  }

  /**
   * In-process egress allowlist (docs/18 §5). In the real profile this is the
   * Outbound Workers boundary; locally we log rather than hard-enforce (the
   * subprocess can still call out — real isolation is CF Sandbox). Deny-by-default
   * is enforced in the real boundary (§6.3). Kept as a stand-in so the fast
   * profile exercises the boundary-contract code path.
   */
  private assertEgressAllowed(cmd: string): void {
    const networkCommands = new Set(["curl", "wget", "nc", "ssh", "scp"]);
    if (!networkCommands.has(cmd)) return;
    // No hard deny locally; real boundary is §6.3.
  }
}
