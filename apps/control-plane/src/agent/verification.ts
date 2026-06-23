// Verification-artifact glue (docs/01 closed-loop verification, docs/16 §2, checklist §8.2).
// Runs the repo's test command in the sandbox, captures the result, uploads it to R2,
// records an artifact on the DO, and folds the artifact link into the PR body.
//
// Pure-ish logic: the R2 + DO calls are injected ports so this is testable. The
// sandbox exec uses the SandboxProvider (§4.3/§6.3); the artifact record + PR body
// use the DO createArtifact / composePrBody surface (§5.2, §8.3).

import { composePrBody } from "../git/pr";
import type { SandboxProvider } from "../sandbox/provider";
import type { Env } from "../env";

/** The result of a verification run. */
export interface VerificationResult {
  ok: boolean;
  exitCode: number;
  output: string;
  durationMs: number;
}

/** Inputs to the verification step. */
export interface VerifyInput {
  sessionId: string;
  /** The repo's test command (from .forge/config.toml build/setup or a default). */
  testCommand: string[];
  /** Where to store the artifact in R2 (the ARTIFACTS bucket). */
  artifactKey: string;
}

/** Ports the verification step needs (injected — testable). */
export interface VerifyPorts {
  sandbox: SandboxProvider;
  /** The sandbox handle (from spawn) to exec the test command in. */
  sandboxHandle: { id: string; workdir: string; imageVersion: string };
  /** Upload a blob to R2, return the r2:// URI. */
  uploadArtifact(key: string, content: string, contentType: string): Promise<string>;
  /** Record an artifact on the session DO (forge.createArtifact, §5.2). */
  recordArtifact(input: {
    type: "test_result" | "screenshot";
    storageUri: string;
    generatedBy: "agent";
    mimeType?: string;
  }): Promise<{ artifactId: string }>;
}

/**
 * Run the verification step: exec the test command → capture output → upload to
 * R2 → record the artifact on the DO (docs/01, checklist §8.2).
 *
 * The artifact (test results JSON) is folded into the PR body by the caller via
 * composePrBody (§8.3) — this step produces the artifact URI + outcome.
 */
export async function runVerification(
  input: VerifyInput,
  ports: VerifyPorts,
): Promise<{ result: VerificationResult; artifactUri: string; artifactId: string }> {
  // 1. Run the test command in the sandbox (docs/01 closed-loop verification).
  const exec = await ports.sandbox.exec(ports.sandboxHandle, input.testCommand);
  const result: VerificationResult = {
    ok: exec.exitCode === 0,
    exitCode: exec.exitCode,
    output: `${exec.stdout}\n${exec.stderr}`.trim(),
    durationMs: exec.durationMs,
  };

  // 2. Upload the result to R2 (the ARTIFACTS bucket, docs/12 §4).
  const artifactContent = JSON.stringify(
    {
      ok: result.ok,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      output: result.output,
      ts: Date.now(),
    },
    null,
    2,
  );
  const artifactUri = await ports.uploadArtifact(
    input.artifactKey,
    artifactContent,
    "application/json",
  );

  // 3. Record the artifact on the DO (forge.createArtifact, §5.2 / §5.15).
  const { artifactId } = await ports.recordArtifact({
    type: "test_result",
    storageUri: artifactUri,
    generatedBy: "agent",
    mimeType: "application/json",
  });

  return { result, artifactUri, artifactId };
}

/**
 * Compose the PR body including the verification artifact (docs/04 §6, §8.3).
 * Called after runVerification + (optionally) a screenshot capture.
 */
export function composePrBodyWithVerification(opts: {
  sessionLink: string;
  summary: string;
  userGithub: string;
  testResult: VerificationResult;
  testArtifactUri: string;
  screenshots?: Array<{ label: string; uri: string }>;
}): string {
  const artifacts: Array<{ label: string; uri: string }> = [
    {
      label: opts.testResult.ok ? "✅ Tests passing" : "❌ Tests failing",
      uri: opts.testArtifactUri,
    },
    ...(opts.screenshots ?? []),
  ];
  return composePrBody({
    sessionLink: opts.sessionLink,
    summary: opts.summary,
    artifacts,
    userGithub: opts.userGithub,
  });
}

/**
 * Build a VerifyPorts implementation bound to a real Env (R2 ARTIFACTS bucket +
 * the session DO). Used by the agent loop; tests inject fakes.
 */
export function buildVerifyPorts(env: Env, sessionId: string): VerifyPorts {
  return {
    sandbox: undefined as unknown as SandboxProvider, // set by the caller (the spawn flow holds the provider)
    sandboxHandle: undefined as unknown as VerifyPorts["sandboxHandle"], // set by the caller
    async uploadArtifact(key, content, contentType) {
      await env.ARTIFACTS.put(key, content, { httpMetadata: { contentType } });
      return `r2://forge-artifacts/${key}`;
    },
    async recordArtifact(artifact) {
      const idObj = env.SESSION_DO.idFromName(sessionId);
      const stub = env.SESSION_DO.get(idObj) as unknown as {
        createArtifact(a: unknown): Promise<{ artifactId: string }>;
      };
      return stub.createArtifact(artifact);
    },
  };
}
