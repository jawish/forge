import { describe, expect, it } from "vitest";
import {
  composePrBodyWithVerification,
  runVerification,
  type VerifyPorts,
  type VerificationResult,
} from "./verification";
import type { SandboxProvider } from "../sandbox/provider";

// Verification-artifact glue (docs/01, docs/16 §2, checklist §8.2). Tests the
// run-tests → R2 → artifact-record flow + the PR-body folding with injected fakes.

function fakeSandbox(exitCode: number, stdout: string): SandboxProvider {
  return {
    async provision() {
      return { id: "sbx_1", workdir: "/w", imageVersion: "v1" };
    },
    async exec(_handle, _cmd) {
      return { exitCode, stdout, stderr: "", durationMs: 42 };
    },
    async snapshot() {
      return { id: "snap", location: "loc", takenAt: 0 };
    },
    async restore() {
      return { id: "sbx_2", workdir: "/w", imageVersion: "v1" };
    },
    async destroy() {},
  };
}

function fakePorts(opts: {
  exitCode: number;
  stdout: string;
  recorded: Array<{ type: string; storageUri: string }>;
}): { ports: VerifyPorts; uploads: Record<string, string> } {
  const uploads: Record<string, string> = {};
  const ports: VerifyPorts = {
    sandbox: fakeSandbox(opts.exitCode, opts.stdout),
    sandboxHandle: { id: "sbx_1", workdir: "/w", imageVersion: "v1" },
    async uploadArtifact(key, content) {
      uploads[key] = content;
      return `r2://forge-artifacts/${key}`;
    },
    async recordArtifact(artifact) {
      opts.recorded.push(artifact);
      return { artifactId: `art_${opts.recorded.length}` };
    },
  };
  return { ports, uploads };
}

describe("runVerification — tests → R2 → artifact (§8.2)", () => {
  it("runs tests, uploads the result to R2, records an artifact", async () => {
    const recorded: Array<{ type: string; storageUri: string }> = [];
    const { ports, uploads } = fakePorts({ exitCode: 0, stdout: "1 passed", recorded });

    const { result, artifactUri, artifactId } = await runVerification(
      { sessionId: "sess_1", testCommand: ["pytest"], artifactKey: "sess_1/test-result.json" },
      ports,
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(artifactUri).toBe("r2://forge-artifacts/sess_1/test-result.json");
    expect(artifactId).toBe("art_1");
    // The uploaded content is the structured test result.
    const uploaded = JSON.parse(uploads["sess_1/test-result.json"]!);
    expect(uploaded.ok).toBe(true);
    expect(uploaded.output).toContain("1 passed");
    // The artifact was recorded on the DO.
    expect(recorded[0]).toMatchObject({ type: "test_result", storageUri: artifactUri });
  });

  it("a failing test run still records an artifact (ok=false)", async () => {
    const recorded: Array<{ type: string; storageUri: string }> = [];
    const { ports } = fakePorts({ exitCode: 1, stdout: "1 failed", recorded });
    const { result } = await runVerification(
      { sessionId: "sess_2", testCommand: ["vitest", "run"], artifactKey: "sess_2/test.json" },
      ports,
    );
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(recorded[0]).toMatchObject({ type: "test_result" });
  });
});

describe("composePrBodyWithVerification — folds the artifact into the PR body (§8.2, §8.3)", () => {
  const passing: VerificationResult = {
    ok: true,
    exitCode: 0,
    output: "all green",
    durationMs: 100,
  };
  const failing: VerificationResult = {
    ok: false,
    exitCode: 1,
    output: "1 failed",
    durationMs: 100,
  };

  it("includes the test artifact link in the body", () => {
    const body = composePrBodyWithVerification({
      sessionLink: "https://forge/s/sess_1",
      summary: "Fixed the bug",
      userGithub: "jawish",
      testResult: passing,
      testArtifactUri: "r2://forge-artifacts/sess_1/test.json",
    });
    expect(body).toContain("r2://forge-artifacts/sess_1/test.json");
    expect(body).toContain("Tests passing");
  });

  it("marks failing tests in the artifact label", () => {
    const body = composePrBodyWithVerification({
      sessionLink: "l",
      summary: "s",
      userGithub: "u",
      testResult: failing,
      testArtifactUri: "r2://forge-artifacts/x.json",
    });
    expect(body).toContain("Tests failing");
  });

  it("includes screenshots (Browser Run, frontend repos) when provided", () => {
    const body = composePrBodyWithVerification({
      sessionLink: "l",
      summary: "s",
      userGithub: "u",
      testResult: passing,
      testArtifactUri: "r2://tests.json",
      screenshots: [{ label: "Before/After", uri: "r2://forge-artifacts/shot.png" }],
    });
    expect(body).toContain("[Before/After](r2://forge-artifacts/shot.png)");
  });
});
