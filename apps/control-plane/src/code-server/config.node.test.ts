import { describe, expect, it } from "vitest";
import {
  buildCodeServerConfig,
  codeServerCommand,
  codeServerDeepLink,
  codeServerDockerfileSnippet,
} from "./config";

// code-server embed config (docs/08 §12, docs/04, checklist §8.2).

describe("buildCodeServerConfig", () => {
  it("builds the config with the workdir + open auth (sandbox boundary handles access)", () => {
    const cfg = buildCodeServerConfig({ workdir: "/workspace" });
    expect(cfg.workspace).toBe("/workspace");
    expect(cfg.port).toBe(3000);
    expect(cfg.auth).toBe("none");
  });

  it("includes extension install args when provided", () => {
    const cfg = buildCodeServerConfig({
      workdir: "/w",
      extensions: ["ms-python.python", "esbenp.prettier-vscode"],
    });
    expect(cfg.extraArgs).toContain("ms-python.python");
    expect(cfg.extraArgs).toContain("esbenp.prettier-vscode");
  });
});

describe("codeServerCommand", () => {
  it("builds the launch command from the config", () => {
    const cmd = codeServerCommand(buildCodeServerConfig({ workdir: "/w" }));
    expect(cmd[0]).toBe("code-server");
    expect(cmd).toContain("--port=3000");
    expect(cmd).toContain("--auth=none");
    expect(cmd[cmd.length - 1]).toBe("/w");
  });
});

describe("codeServerDeepLink", () => {
  it("builds the Web deep-link to open code-server for a session", () => {
    expect(
      codeServerDeepLink({ workerOrigin: "https://forge.example.com", sessionId: "sess_1" }),
    ).toBe("https://forge.example.com/code/sess_1");
  });
});

describe("codeServerDockerfileSnippet", () => {
  it("produces the install snippet", () => {
    expect(codeServerDockerfileSnippet()).toContain("code-server.dev/install.sh");
  });
});
