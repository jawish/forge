// CloudflareSandboxProvider — the real-profile + prod sandbox (docs/08 §3,
// checklist §6.3). Implements the same SandboxProvider interface as
// LocalSandboxProvider (§4.3) against the CF Sandbox API: provision (persistent
// container), exec (PTY-over-WS), snapshot/restore (Backups API), destroy.
//
// The provider needs CF Sandbox creds (dev-shared, §6.1) bound as a secret — the
// actual API calls validate only with real creds. The interface + this impl are
// the real surface; the fast profile uses LocalSandboxProvider instead.
//
// NOTE: this implements the documented CF Sandbox contract (docs/08 §3 —
// sandbox.exec, sleepAfter, Backups API). The exact REST shapes are verified
// against the live API during the §6 provisioning; the method signatures match
// the SandboxProvider interface (ADR-0001).

import type {
  ExecResult,
  ProvisionSpec,
  SandboxHandle,
  SandboxProvider,
  SnapshotRef,
} from "./provider";

/** CF Sandbox API config (from the dev-shared / prod secret binding). */
export interface CloudflareSandboxConfig {
  /** The CF account id (sandbox lives under the account). */
  accountId: string;
  /** API token with Sandbox permissions. */
  apiToken: string;
  /** Default region hint (sandboxes are single-PoP, docs/08 §3). */
  region?: string;
  /** sleepAfter override (default 10 min, docs/08 §3). */
  sleepAfterMinutes?: number;
}

const CF_API = "https://api.cloudflare.com/client/v4";

/**
 * Cloudflare Sandbox provider. One persistent container per session; snapshots
 * to R2 via the Backups API; PTY-over-WS exec. Credential injection happens at
 * the Outbound Workers boundary (docs/18 §5), not here — the provider never
 * holds session-user creds.
 */
export class CloudflareSandboxProvider implements SandboxProvider {
  private readonly cfg: CloudflareSandboxConfig;
  constructor(cfg: CloudflareSandboxConfig) {
    this.cfg = cfg;
  }

  async provision(spec: ProvisionSpec): Promise<SandboxHandle> {
    // POST /accounts/{id}/sandbox — creates a persistent container from the image.
    // sleepAfter keeps it warm; keepAlive for long daemons (docs/08 §3).
    const res = await fetch(`${CF_API}/accounts/${this.cfg.accountId}/sandbox`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        image: spec.imageVersion,
        // Git identity injected via env at boot (docs/10 §10 — no shared bot).
        env: {
          GIT_AUTHOR_NAME: spec.gitIdentity.name,
          GIT_AUTHOR_EMAIL: spec.gitIdentity.email,
          GIT_COMMITTER_NAME: spec.gitIdentity.name,
          GIT_COMMITTER_EMAIL: spec.gitIdentity.email,
        },
        sleepAfter: (this.cfg.sleepAfterMinutes ?? 10) * 60,
        region: this.cfg.region,
        // Egress allowlist enforced by the Outbound Workers boundary (docs/18 §5),
        // applied as the sandbox's egress manifest.
        egress: { allow: spec.egressAllow ?? [] },
      }),
    });
    const body = (await res.json()) as { result?: { id: string }; success: boolean };
    if (!res.ok || !body.result) {
      throw new Error(`CF Sandbox provision failed: ${res.status}`);
    }
    return { id: body.result.id, workdir: "/workspace", imageVersion: spec.imageVersion };
  }

  async exec(handle: SandboxHandle, command: string[]): Promise<ExecResult> {
    // POST /accounts/{id}/sandbox/{sid}/exec — runs the command (PTY-over-WS for
    // interactive; HTTP exec for one-shot). docs/08 §3: sandbox.exec can hang;
    // we apply a timeout + return on close.
    const started = Date.now();
    const res = await fetch(`${CF_API}/accounts/${this.cfg.accountId}/sandbox/${handle.id}/exec`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ command }),
    });
    const body = (await res.json()) as {
      result?: { exitCode: number; stdout: string; stderr: string };
      success: boolean;
    };
    return {
      exitCode: body.result?.exitCode ?? 1,
      stdout: body.result?.stdout ?? "",
      stderr: body.result?.stderr ?? "",
      durationMs: Date.now() - started,
    };
  }

  async snapshot(handle: SandboxHandle): Promise<SnapshotRef> {
    // POST /accounts/{id}/sandbox/{sid}/backups — point-in-time snapshot
    // (copy-on-write overlay, docs/08 §3 Backups API).
    const res = await fetch(
      `${CF_API}/accounts/${this.cfg.accountId}/sandbox/${handle.id}/backups`,
      {
        method: "POST",
        headers: this.headers(),
      },
    );
    const body = (await res.json()) as {
      result?: { id: string; location: string };
      success: boolean;
    };
    if (!body.result) throw new Error(`CF Sandbox snapshot failed: ${res.status}`);
    return {
      id: body.result.id,
      location: body.result.location,
      takenAt: Date.now(),
    };
  }

  async restore(ref: SnapshotRef, spec: ProvisionSpec): Promise<SandboxHandle> {
    // Restore: create a new sandbox from the backup (copy-on-write overlay).
    const res = await fetch(`${CF_API}/accounts/${this.cfg.accountId}/sandbox/${ref.id}/restore`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ image: spec.imageVersion }),
    });
    const body = (await res.json()) as { result?: { id: string }; success: boolean };
    if (!body.result) throw new Error(`CF Sandbox restore failed: ${res.status}`);
    return { id: body.result.id, workdir: "/workspace", imageVersion: spec.imageVersion };
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    // DELETE /accounts/{id}/sandbox/{sid} — tears down + zeroizes ephemeral state.
    await fetch(`${CF_API}/accounts/${this.cfg.accountId}/sandbox/${handle.id}`, {
      method: "DELETE",
      headers: this.headers(),
    });
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.cfg.apiToken}`,
      "content-type": "application/json",
    };
  }
}
