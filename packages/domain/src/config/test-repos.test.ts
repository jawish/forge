import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRepoConfig, repoConfigSchema } from "../index";

// The §7.2 test-repo fixtures (docs/16 §2) — minimal Python + TS repos with
// .forge/config.toml. This test validates each fixture's config parses + matches
// repoConfigSchema, so the build-pipeline test corpus is correct by construction.

const here = dirname(fileURLToPath(import.meta.url));
// From packages/domain/src/config/ → repo root → infra/images/sandboxes/test-repos
const testReposDir = join(
  here,
  "..",
  "..",
  "..",
  "..",
  "infra",
  "images",
  "sandboxes",
  "test-repos",
);

function listTestRepos(): string[] {
  try {
    return readdirSync(testReposDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return []; // dir absent in some CI checkouts
  }
}

describe("§7.2 test-repo fixtures (docs/16 §2)", () => {
  const repos = listTestRepos();

  it("includes a python-service and a ts-service fixture", () => {
    // Don't hard-fail if the dir is absent in a partial checkout, but assert when present.
    if (repos.length === 0) return;
    expect(repos).toEqual(expect.arrayContaining(["python-service", "ts-service"]));
  });

  // Only test repos that have a readable config.toml (skip partial checkouts gracefully).
  const reposWithConfig = repos
    .map((repo) => ({
      repo,
      toml: readTomlSafe(join(testReposDir, repo, ".forge", "config.toml")),
    }))
    .filter((r): r is { repo: string; toml: string } => r.toml !== null);

  for (const { repo, toml } of reposWithConfig) {
    describe(`${repo}/.forge/config.toml`, () => {
      it("parses via parseRepoConfig without error", () => {
        expect(() => parseRepoConfig(toml)).not.toThrow();
      });

      it("is accepted by repoConfigSchema directly", () => {
        const cfg = parseRepoConfig(toml);
        expect(() => repoConfigSchema.parse(cfg)).not.toThrow();
      });

      it("has the required build section (dockerfile + setup_script + base_image)", () => {
        const cfg = parseRepoConfig(toml);
        expect(cfg.build.dockerfile).toMatch(/Dockerfile$/);
        expect(cfg.build.setup_script).toMatch(/setup\.sh$/);
        expect(cfg.build.base_image).toMatch(/^chainguard\//);
      });

      it("declares a default model", () => {
        const cfg = parseRepoConfig(toml);
        expect(cfg.model.default.length).toBeGreaterThan(0);
      });

      it("marks secrets/ + .env* sensitive (sanitization layer 1, docs/18 §2)", () => {
        const cfg = parseRepoConfig(toml);
        expect(cfg.paths.sensitive).toEqual(expect.arrayContaining(["secrets/**", ".env*"]));
      });

      it("declares an egress allowlist (docs/18 §5)", () => {
        const cfg = parseRepoConfig(toml);
        expect(cfg.egress.allow.length).toBeGreaterThan(0);
      });
    });
  }
});

/** Read a TOML file, returning null if absent (partial-checkout tolerant). */
function readTomlSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
