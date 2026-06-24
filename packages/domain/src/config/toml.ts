// TOML parser for .forge/config.toml (docs/13 §2). Parses then validates against
// repoConfigSchema. Failures surface as CONFIG_VALIDATION_FAILED (category
// invalid_input — docs/15 §3). One parser, pinned dep (smol-toml, 09 §2 spirit).

import { parse as parseToml } from "smol-toml";
import { repoConfigSchema, type RepoConfig } from "./repo-config";

export { repoConfigSchema } from "./repo-config";
export { orgConfigSchema, envConfigSchema } from "./org-env";
export type {
  RepoConfig,
  BuildConfig,
  PrewarmConfig,
  ModelConfig,
  McpConfig,
  PolicyConfig,
  PathsConfig,
  GitConfig,
  GitIdentityStrategy,
} from "./repo-config";
export type { OrgConfig, EnvConfig } from "./org-env";

export class ConfigParseError extends Error {
  readonly code = "CONFIG_VALIDATION_FAILED" as const;
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ConfigParseError";
  }
}

/**
 * Parse + validate a .forge/config.toml string into a RepoConfig.
 * Throws ConfigParseError on TOML syntax errors or schema violations.
 */
export function parseRepoConfig(toml: string): RepoConfig {
  let parsed: unknown;
  try {
    parsed = parseToml(toml);
  } catch (e) {
    throw new ConfigParseError(
      `.forge/config.toml: TOML syntax error — ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
  const result = repoConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  at [${i.path.join(".")}]: ${i.message}`)
      .join("\n");
    throw new ConfigParseError(`.forge/config.toml failed validation:\n${issues}`, result.error);
  }
  return result.data;
}
