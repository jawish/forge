# forge-test-python-service

Minimal Python service fixture for Forge sandbox/image-build tests (docs/16 §2).
Used by the §7.2 spike (build → cosign sign → GHCR) and repo-config validation.

- `.forge/config.toml` — valid per `@forge/domain` `repoConfigSchema` (docs/13 §2).
- `app/main.py` — a tiny FastAPI service with `/health`.
- `tests/test_health.py` — the agent's verification loop runs these.

Real per-repo services vary; this is the test corpus for the build pipeline.
