# Forge — Configuration Model

**Version**: 1.0 (locked)
**Status**: Authoritative for all configuration across the platform.
**Companion docs**: `09_Project_Structure.md` (where packages live), `11_State_Model.md` (policy fields referenced), `12_Data_Schemas.md` (`repo` table).

> Three configuration domains, each with its natural source of truth. Repo config lives in the repo (TOML); the Web UI is a PR-generating editor, not a separate store. Config changes are git commits — a free audit trail.

---

## 1. The three configuration domains

| Domain | Source of truth | Edited by | Lives in |
|---|---|---|---|
| **Repo config** | `.forge/config.toml` in the repo | Repo owners (via CLI or Web UI wizard that opens a PR) | Git (versioned, diff-able, auditable) |
| **Platform / org config** | D1 | Platform team / admins (via admin UI or API) | D1 tables (global defaults, team budgets, feature flags, kill-switch) |
| **Env / infra config** | Pulumi + Secrets Store | Platform team via IaC | `infra/pulumi/Pulumi.<env>.yaml` + CF Secrets Store |

**Never conflate these.** They have different authors, lifecycles, validation needs, and trust levels.

---

## 2. Repo config — `.forge/config.toml`

The canonical source for *all* per-repo config (build AND runtime). TOML format (human-friendly, comments, mise/Pulumi-aligned). Validated by a zod schema in `packages/domain/src/config/`.

### Full schema

```toml
# .forge/config.toml — in the repo, versioned with code

[build]
dockerfile = ".forge/Dockerfile"           # path to Dockerfile (relative to repo root)
setup_script = ".forge/setup.sh"           # runs during image build (install deps, init caches)
base_image = "chainguard/node:22"           # Chainguard-derived base (08 §15)

[prewarm]
commands = [                                # run on warm-pool snapshot restore
  "pnpm install --frozen-lockfile",
  "pnpm build"
]
warm_pool_size = 3                          # target warm sandboxes for this repo (0 = no warm pool)

[model]
default = "claude-sonnet-4-6"              # tier-2 default (08 §6); per-session override allowed
fallback_tier = "flex"                      # tier to use if default is unavailable

[mcp]
allowlist = [                               # registry-managed MCP servers enabled for this repo
  "memory",
  "linear"
]
# platform-provided MCPs (forge.reportStatus, Browser Run, Stagehand) are always available

[policy]                                    # state-machine policy overrides (11 §6)
review_agent_required = false               # require Review Agent pass before ready_for_pr → pr_open
stuck_threshold_turns = 10                  # turns without progress → activity=stuck
stuck_timeout_minutes = 5                   # stuck → status=failed
budget_limit_usd = 5.00                     # per-session cost cap (null = inherit team default)

[paths]
sensitive = [                               # agent cannot read/write (sanitization layer 1, 18 §2)
  "secrets/**",
  ".env*",
  "*.pem",
  "*.key"
]
readonly = [                               # agent can read but not write
  "docs/policies/**"
]

[git]
identity_strategy = "user"                  # 'user' (per-user OAuth) | 'bot' (shared Forge bot identity)
default_branch = "main"
```

### Source-of-truth rule

The `.forge/config.toml` in the repo is canonical. The control plane parses it on webhook (push to default branch or `.forge/` path), validates with zod, and **projects** to D1 (`repo.tuning_json` — read-only). The projection is never edited directly.

### Web UI as PR editor

The Repo Settings UI (per US-0.3) edits `.forge/config.toml` by **opening a PR** with the change — not by writing to D1 directly. Repo owner merges the PR; webhook re-parses; projection updates. This means:

- One source of truth (the repo).
- Every config change is a git commit (author, diff, history — free audit trail).
- UI and CLI edit the same file; no drift.
- Config changes go through code review if the repo requires it.

### Build-time vs runtime fields

The bake-vs-runtime split is already determined by what each field is for — not a separate decision:

- **Build-time** (`[build]`, `[prewarm]`): consumed during image build. A change triggers a rebuild (new `repo_image_version`).
- **Runtime** (`[model]`, `[mcp]`, `[policy]`, `[paths]`, `[git]`): consumed at session spawn. Read from the D1 projection; no rebuild needed.

The control plane detects which section changed and triggers rebuild only when build-time fields change.

---

## 3. Platform / org config (D1)

Global, cross-repo config. Edited by Platform/admins via admin UI or API. Stored in D1; cached in KV for hot-path reads.

| Config | D1 location | Purpose |
|---|---|---|
| Global model defaults | `org_config` (key-value) | Fallback when repo doesn't specify a model |
| Team budgets | `team` table (12 §3) | Per-team daily/weekly cost caps |
| Kill-switch | KV `flag:killswitch` | Platform-wide pause (checked synchronously before every model call) |
| Feature flags | Flagship (managed) | Per-feature rollout control |
| Review Agent policy defaults | `org_config` | Default Review Agent requirement (repo can override) |
| Model provider routing | `org_config` | Which providers/tiers are enabled for the org |

### Cache invalidation

D1 → KV cache has a 5-min TTL. Config updates trigger an immediate KV invalidation via the control plane. The hot path reads KV; falls back to D1 on miss.

---

## 4. Env / infra config (Pulumi + Secrets Store)

Per-environment (dev/staging/prod — see `17_Environments.md`). Not in any repo's `.forge/`; lives in `infra/pulumi/`.

| Config | Source | Bound to |
|---|---|---|
| Resource IDs (D1 database, R2 buckets, KV namespace, etc.) | Pulumi stack (`Pulumi.<env>.yaml`) | Workers at deploy |
| Provider API keys (OpenAI, Anthropic, etc.) | CF Secrets Store (Pulumi-managed, `pulumi config set-secret`) | AI Gateway config |
| GitHub App private key | CF Secrets Store | control-plane Worker |
| Slack tokens | CF Secrets Store | control-plane Worker |
| ClickHouse credentials | CF Secrets Store | Pipelines config |
| User OAuth master key | CF Secrets Store | D1 encryption envelope |

### Secrets promotion (dev → staging → prod)

Pulumi-managed with CI gate + 2-person approval for prod (see `17_Environments.md` §secrets). Git audit trail via Pulumi config commits; drift detection via `pulumi diff`.

---

## 5. Config validation

All three domains validate via zod schemas in `packages/domain/src/config/`:

- `repoConfigSchema` — validates `.forge/config.toml` on parse.
- `orgConfigSchema` — validates admin UI input.
- `envConfigSchema` — validates Pulumi stack output.

Validation failures are `CONFIG_VALIDATION_FAILED` errors (category `invalid_input` — see `15_Error_Model.md`). For repo config, the webhook handler posts a comment on the triggering commit explaining the validation error.

---

## 6. Config change audit

Because repo config lives in git, **config changes are auditable by construction** — `git log` on `.forge/config.toml` answers "who changed the MCP allowlist, when, why." No separate audit-log infrastructure needed for repo config.

Platform/org config changes (D1) emit Audit Events to R2 (per `08` §5) with `action=policy_change`.

Env config changes (Pulumi) are in git history + Pulumi's own state log.
