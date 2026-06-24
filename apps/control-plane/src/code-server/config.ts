// code-server in-sandbox embed (docs/08 §12, docs/04 Journey B, checklist §8.2).
// The hosted VS Code (code-server) runs in the SAME sandbox session; one click
// from the Web opens it. This module generates the code-server config written
// into the sandbox image + the Web deep-link format.
//
// The actual code-server process runs in the CF Sandbox (§6); this is the config
// + deep-link layer (code-writable, testable).

/** A code-server launch config for a session. */
export interface CodeServerConfig {
  /** The port code-server listens on in the sandbox. */
  port: number;
  /** The workspace root (the sandbox workdir). */
  workspace: string;
  /** Whether auth is enabled (false — the sandbox boundary handles access). */
  auth: "none" | "password";
  /** Extra CLI args (e.g. extensions to install). */
  extraArgs?: string[];
}

/** Build the code-server config for a sandbox session (docs/08 §12). */
export function buildCodeServerConfig(opts: {
  workdir: string;
  extensions?: string[];
}): CodeServerConfig {
  return {
    port: 3000,
    workspace: opts.workdir,
    auth: "none", // the CF Sandbox + CF Access handle auth; code-server itself is open
    extraArgs: opts.extensions?.length ? ["--install-extension", ...opts.extensions] : [],
  };
}

/** The code-server launch command (written to the sandbox setup). */
export function codeServerCommand(config: CodeServerConfig): string[] {
  return [
    "code-server",
    `--port=${config.port}`,
    `--auth=${config.auth}`,
    "--disable-telemetry",
    "--trust-proxy",
    config.workspace,
    ...(config.extraArgs ?? []),
  ];
}

/**
 * The Web deep-link to open code-server for a session (docs/04 Journey B).
 * The control-plane Worker proxies the code-server port from the sandbox via the
 * session's WS route (or a dedicated /code/:sessionId route — §8.2 widening).
 */
export function codeServerDeepLink(opts: { workerOrigin: string; sessionId: string }): string {
  return `${opts.workerOrigin}/code/${opts.sessionId}`;
}

/** The Dockerfile snippet to add code-server to a sandbox image (docs/08 §12). */
export function codeServerDockerfileSnippet(): string {
  return [
    "# code-server — hosted VS Code in the sandbox (docs/08 §12).",
    "USER root",
    "RUN curl -fsSL https://code-server.dev/install.sh | sh",
    "# Extensions installed on first launch (buildCodeServerConfig extraArgs).",
  ].join("\n");
}
