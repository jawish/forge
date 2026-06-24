import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRepoConfig, repoConfigSchema, ConfigParseError } from "../index";

const here = dirname(fileURLToPath(import.meta.url));
const readFixture = (name: string) =>
  readFileSync(join(here, "..", "test", "fixtures", name), "utf8");

describe("repoConfigSchema — accepts the docs/13 §2 example", () => {
  const valid = readFixture("valid-config.toml");

  it("parseRepoConfig parses the golden example without error", () => {
    const cfg = parseRepoConfig(valid);
    expect(cfg.build.dockerfile).toBe(".forge/Dockerfile");
    expect(cfg.model.default).toBe("claude-sonnet-4-6");
    expect(cfg.prewarm.warm_pool_size).toBe(3);
    expect(cfg.mcp.allowlist).toEqual(["memory", "linear"]);
    expect(cfg.policy.review_agent_required).toBe(false);
    expect(cfg.policy.budget_limit_usd).toBe(5.0);
    expect(cfg.paths.sensitive).toContain("secrets/**");
    expect(cfg.git.identity_strategy).toBe("user");
  });

  it("repoConfigSchema (direct zod) accepts the parsed object", () => {
    const cfg = repoConfigSchema.parse({
      build: {
        dockerfile: ".forge/Dockerfile",
        setup_script: ".forge/setup.sh",
        base_image: "chainguard/node:22",
      },
      model: { default: "claude-sonnet-4-6" },
    });
    // Defaults applied for omitted sections.
    expect(cfg.prewarm.warm_pool_size).toBe(0);
    expect(cfg.policy.stuck_threshold_turns).toBe(10);
    expect(cfg.git.default_branch).toBe("main");
    expect(cfg.mcp.allowlist).toEqual([]);
  });
});

describe("repoConfigSchema — applies sensible defaults for omitted sections", () => {
  it("a build+model-only config is valid", () => {
    const minimal = `
[build]
dockerfile = "Dockerfile"
setup_script = "setup.sh"
base_image = "chainguard/node:22"

[model]
default = "claude-sonnet-4-6"
`;
    const cfg = parseRepoConfig(minimal);
    expect(cfg.prewarm.commands).toEqual([]);
    expect(cfg.prewarm.warm_pool_size).toBe(0);
    expect(cfg.model.fallback_tier).toBe("flex");
    expect(cfg.policy.review_agent_required).toBe(false);
    expect(cfg.policy.stuck_timeout_minutes).toBe(5);
    expect(cfg.paths.sensitive).toEqual([]);
    expect(cfg.paths.readonly).toEqual([]);
    expect(cfg.git.identity_strategy).toBe("user");
    expect(cfg.git.default_branch).toBe("main");
  });

  it("policy.budget_limit_usd defaults to 5.0 (null = inherit, but default is 5)", () => {
    const cfg = parseRepoConfig(
      `[build]\ndockerfile="D"\nsetup_script="S"\nbase_image="B"\n[model]\ndefault="m"`,
    );
    expect(cfg.policy.budget_limit_usd).toBe(5.0);
  });
});

describe("repoConfigSchema — rejects malformed config (docs/13 §5)", () => {
  const malformed = readFixture("malformed-config.toml");

  it("parseRepoConfig throws ConfigParseError with code CONFIG_VALIDATION_FAILED", () => {
    try {
      parseRepoConfig(malformed);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigParseError);
      expect((e as ConfigParseError).code).toBe("CONFIG_VALIDATION_FAILED");
      expect((e as Error).message).toContain("validation");
    }
  });

  it("rejects a missing required build.dockerfile", () => {
    expect(() =>
      parseRepoConfig(`[build]\nsetup_script="S"\nbase_image="B"\n[model]\ndefault="m"`),
    ).toThrow(ConfigParseError);
  });

  it("rejects a negative warm_pool_size", () => {
    expect(() =>
      parseRepoConfig(
        `[build]\ndockerfile="D"\nsetup_script="S"\nbase_image="B"\n[model]\ndefault="m"\n[prewarm]\nwarm_pool_size = -1`,
      ),
    ).toThrow(ConfigParseError);
  });

  it("rejects stuck_threshold_turns <= 0", () => {
    expect(() =>
      parseRepoConfig(
        `[build]\ndockerfile="D"\nsetup_script="S"\nbase_image="B"\n[model]\ndefault="m"\n[policy]\nstuck_threshold_turns = 0`,
      ),
    ).toThrow(ConfigParseError);
  });

  it("rejects an invalid git identity_strategy", () => {
    expect(() =>
      parseRepoConfig(
        `[build]\ndockerfile="D"\nsetup_script="S"\nbase_image="B"\n[model]\ndefault="m"\n[git]\nidentity_strategy = "random"`,
      ),
    ).toThrow(ConfigParseError);
  });

  it("rejects invalid TOML syntax (ConfigParseError, not a raw throw)", () => {
    expect(() => parseRepoConfig(`[build\n = broken`)).toThrow(ConfigParseError);
  });
});
