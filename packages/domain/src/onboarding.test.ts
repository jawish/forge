import { describe, expect, it } from "vitest";
import { generateRepoConfig } from "./onboarding";
import { parseRepoConfig, repoConfigSchema } from "./index";

// Self-service repo onboarding config generator (docs/13 §2, §9). Pure-logic tests:
// the wizard input → a valid .forge/config.toml that parses + matches repoConfigSchema.

describe("generateRepoConfig (docs/13 §2, §9)", () => {
  it("produces a config that parses + matches repoConfigSchema", () => {
    const toml = generateRepoConfig({ language: "python" });
    const cfg = parseRepoConfig(toml);
    expect(() => repoConfigSchema.parse(cfg)).not.toThrow();
  });

  it("picks the Chainguard base image per language", () => {
    expect(parseRepoConfig(generateRepoConfig({ language: "python" })).build.base_image).toBe(
      "chainguard/python:latest",
    );
    expect(parseRepoConfig(generateRepoConfig({ language: "typescript" })).build.base_image).toBe(
      "chainguard/node:22",
    );
    expect(parseRepoConfig(generateRepoConfig({ language: "go" })).build.base_image).toBe(
      "chainguard/go:latest",
    );
  });

  it("defaults the model to the tier-2 workhorse", () => {
    expect(parseRepoConfig(generateRepoConfig({ language: "node" })).model.default).toBe(
      "claude-sonnet-4-6",
    );
  });

  it("defaults sensitive paths to secrets/ + .env* + keys", () => {
    const cfg = parseRepoConfig(generateRepoConfig({ language: "python" }));
    expect(cfg.paths.sensitive).toEqual(
      expect.arrayContaining(["secrets/**", ".env*", "*.pem", "*.key"]),
    );
  });

  it("defaults egress to the language's package registry", () => {
    expect(parseRepoConfig(generateRepoConfig({ language: "python" })).egress.allow).toEqual(
      expect.arrayContaining(["pypi.org:443", "api.github.com:443"]),
    );
    expect(parseRepoConfig(generateRepoConfig({ language: "typescript" })).egress.allow).toEqual(
      expect.arrayContaining(["registry.npmjs.org:443"]),
    );
  });

  it("respects user-provided overrides", () => {
    const toml = generateRepoConfig({
      language: "python",
      baseImage: "custom/python:3.12",
      defaultBranch: "develop",
      defaultModel: "gpt-5.5",
      sensitivePaths: ["secrets/**", "config/prod/**"],
      egressAllow: ["internal.registry:443"],
    });
    const cfg = parseRepoConfig(toml);
    expect(cfg.build.base_image).toBe("custom/python:3.12");
    expect(cfg.git.default_branch).toBe("develop");
    expect(cfg.model.default).toBe("gpt-5.5");
    expect(cfg.paths.sensitive).toContain("config/prod/**");
    expect(cfg.egress.allow).toEqual(["internal.registry:443"]);
  });
});
