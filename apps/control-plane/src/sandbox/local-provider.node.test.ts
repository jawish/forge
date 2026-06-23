import { describe, expect, it } from "vitest";
import { LocalSandboxProvider } from "./local-provider";

// LocalSandboxProvider — fast-profile sandbox (docs/09 §5, checklist §4.3).
// Pure unit tests: provision/exec/snapshot/restore/destroy against a local
// subprocess. No miniflare needed (the provider is plain Node code).

describe("LocalSandboxProvider (fast profile)", () => {
  it("provisions a sandbox with a fresh workdir + git identity", async () => {
    const provider = new LocalSandboxProvider();
    const handle = await provider.provision({
      repoId: "repo_1",
      imageVersion: "img_v1",
      gitIdentity: { name: "Alice", email: "alice@example.com" },
    });
    expect(handle.id).toMatch(/^local-/);
    expect(handle.workdir).toBeTruthy();
    expect(handle.imageVersion).toBe("img_v1");
    await provider.destroy(handle);
  });

  it("exec runs a command in the workdir and returns exit code", async () => {
    const provider = new LocalSandboxProvider();
    const handle = await provider.provision({
      repoId: "repo_1",
      imageVersion: "img_v1",
      gitIdentity: { name: "A", email: "a@x.com" },
    });
    const result = await provider.exec(handle, ["sh", "-c", "echo hello && exit 0"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    await provider.destroy(handle);
  });

  it("exec surfaces non-zero exit codes", async () => {
    const provider = new LocalSandboxProvider();
    const handle = await provider.provision({
      repoId: "repo_1",
      imageVersion: "img_v1",
      gitIdentity: { name: "A", email: "a@x.com" },
    });
    const result = await provider.exec(handle, ["sh", "-c", "echo err >&2 && exit 3"]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.trim()).toBe("err");
    await provider.destroy(handle);
  });

  it("snapshot returns a ref; restore provisions a fresh workdir", async () => {
    const provider = new LocalSandboxProvider();
    const handle = await provider.provision({
      repoId: "repo_1",
      imageVersion: "img_v1",
      gitIdentity: { name: "A", email: "a@x.com" },
    });
    const snap = await provider.snapshot(handle);
    expect(snap.id).toMatch(/^snap-/);
    expect(snap.takenAt).toBeGreaterThan(0);
    const restored = await provider.restore(snap, {
      repoId: "repo_1",
      imageVersion: "img_v1",
      gitIdentity: { name: "A", email: "a@x.com" },
    });
    expect(restored.id).not.toBe(handle.id);
    await provider.destroy(handle);
    await provider.destroy(restored);
  });

  it("destroy removes the workdir", async () => {
    const provider = new LocalSandboxProvider();
    const handle = await provider.provision({
      repoId: "repo_1",
      imageVersion: "img_v1",
      gitIdentity: { name: "A", email: "a@x.com" },
    });
    await provider.destroy(handle);
    // idempotent: second destroy is a no-op
    await expect(provider.destroy(handle)).resolves.toBeUndefined();
  });
});
