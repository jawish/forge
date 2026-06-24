# forge-test-ts-service

Minimal TypeScript service fixture for Forge sandbox/image-build tests (docs/16 §2).
Used by the §7.2 spike (build → cosign sign → GHCR) and repo-config validation.

- `.forge/config.toml` — valid per `@forge/domain` `repoConfigSchema`.
- `src/main.ts` — a tiny service with a `health()` export.
- `test/main.test.ts` — the agent's verification loop runs these.

Real per-repo services vary; this is the test corpus for the build pipeline.
