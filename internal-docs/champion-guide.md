# Repo champion guide

As a repo champion, you onboard your repo to Forge and tune it for your team's
conventions. ~10 min once; tweaks during pilot.

## 1. Onboard your repo

Forge operates on repos with a `.forge/config.toml`. Onboard via the self-service
wizard (Phase 2) or by opening a PR adding the file. Minimal valid config:

```toml
# .forge/config.toml
[build]
dockerfile = ".forge/Dockerfile"
setup_script = ".forge/setup.sh"
base_image = "chainguard/node:22"

[model]
default = "claude-sonnet-4-6"
```

Everything else (`[prewarm]`, `[mcp]`, `[policy]`, `[paths]`, `[git]`, `[egress]`,
`[credentials]`) is optional with sensible defaults. See `docs/13_Configuration.md`
§2 for the full schema + the canonical example.

> **Validation:** the control plane parses + validates `.forge/config.toml` on
> push (zod). A malformed config gets a comment on the triggering commit.

## 2. Tune for your repo

| Section | What to tune |
|---|---|
| `[build]` | Dockerfile + setup script (install deps, init caches). Chainguard base (docs/08 §15). |
| `[prewarm]` | `commands` (run on warm-pool restore) + `warm_pool_size` for high-volume repos. |
| `[model]` | `default` (tier-2 workhorse) + `fallback_tier`. |
| `[mcp]` | `allowlist` of registry-managed MCPs (memory, linear, …). Platform MCPs are always available. |
| `[policy]` | `review_agent_required` (high-sensitivity repos), `stuck_threshold_turns`, `budget_limit_usd`. |
| `[paths]` | `sensitive` (never read/write) + `readonly` (read-only). **The security-critical one.** |
| `[git]` | `identity_strategy` (user per-user OAuth, or bot), `default_branch`. |
| `[egress]` / `[credentials]` | Outbound Workers allowlist + credential injection map (docs/18 §5). |

## 3. Set sensitive paths (important)

`[paths] sensitive` is sanitization layer 1 (docs/18 §2) — the agent **never**
reads or writes these. Default to broad:

```toml
[paths]
sensitive = ["secrets/**", ".env*", "*.pem", "*.key", "**/service-account*.json"]
readonly = ["docs/policies/**"]
```

## 4. Drive adoption on your repo

- Add `@forge` to your team's bug/feature channels.
- Dogfood: run a few sessions yourself, then share the PR links in team standup.
- Watch the [Cost dashboard](../infra/grafana/dashboards/cost.json) + the session
  outcomes — flag surprises to `#forge-support`.
- Feed back failure modes (common tool errors, stuck sessions) — that's the
  data flywheel (docs/01 §3).

## 5. Per-repo budgets

`[policy] budget_limit_usd` is the per-session cap (default inherits team). Tune
per repo sensitivity. The KV kill-switch pauses all model calls platform-wide on
incident (docs/08 §17) — Platform operates that, not champions.

## Reference

- Full config schema: `docs/13_Configuration.md` §2
- State-machine policy fields: `docs/11_State_Model.md` §6
- Security model: `docs/18_Security_Contracts.md`
- Pilot goals + your role: `docs/07_Implementation_Roadmap.md` §4
