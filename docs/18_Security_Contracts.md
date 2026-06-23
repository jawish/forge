# Forge — Security Contracts

**Status**: Authoritative for sanitization pipeline + Outbound Workers boundary contract.
**Companion docs**: `08_Tech_Stack.md` §3/§5/§15 (sandbox, audit, supply chain), `12_Data_Schemas.md` (ClickHouse session_event), `13_Configuration.md` (sensitive paths).

> Two security primitives that have been referenced everywhere but never specified until now: the sanitization pipeline (prevents sensitive data reaching the analytics lake) and the Outbound Workers boundary (prevents the March-2026 incident shape — agent gets credential access, deletes prod).

---

# Part A: Sanitization Pipeline

## 1. The model: projection-first, not filter-first

Don't filter raw data (redaction is only as good as the patterns). **Project a deliberately-limited view** — the ClickHouse analytics event schema includes only structurally-safe fields by construction. You can't leak what you never included.

### The principle

Raw session data (prompts, tool args, tool results, file contents) legitimately lives in:
- **DO SQLite** (per-session, ephemeral, locked to the DO)
- **R2 audit** (Object Lock, compliance-grade, break-glass access)

Those stores are *supposed* to have raw data — the audit trail is useless without it. Sanitizing them defeats their purpose.

**The only crossing that needs sanitization is DO → Pipelines → ClickHouse.** ClickHouse is the analytics lake — broadly queryable, lower trust. Raw data must not appear there.

## 2. The projection — what's in ClickHouse by construction

The `session_event.payload` (`12` §5) includes only safe, structural fields:

| Included (safe by construction) | NEVER in ClickHouse |
|---|---|
| `event_type`, `session_id`, `repo_id`, `user_id` | Raw prompt text |
| `status`, `activity` | Tool args |
| `model`, `cost_usd`, `tokens_in/out` | Tool results |
| `duration_ms`, `tool_name`, `outcome` | File contents |
| `intent_category` (classified at ingestion) | Environment variable values |
| `error_message_truncated` (redacted — see §3) | Internal hostnames (unredacted) |

Rich content lives in **R2 audit only**, accessible via **break-glass** for incident investigation (separate authorization, logged, time-bounded).

## 3. The narrow redaction job (for the few included content fields)

A few content fields are deliberately included in the projection (`error_message_truncated`, `intent_category`). These might contain a secret in edge cases (e.g., a tool error that echoes an env var). The layered redaction cleans *these specific fields only* — not the whole event.

### Layered redaction (defense-in-depth on the small remaining surface)

| Layer | Mechanism | Catches |
|---|---|---|
| **Prevent** | Tool/path allowlists (Outbound Workers + `.forge/config.toml` `[paths]` sensitive) | The agent never reads `secrets/` or `.env*` in the first place (sanitization layer 1 — most effective) |
| **Structured** | Regex: AWS keys (`AKIA...`), GitHub tokens (`ghp_/gho_...`), JWTs, PEM blocks, IBANs, credit cards (Luhn), SSNs, emails | Known secret shapes (~100% recall on known formats) |
| **Contextual** | Heuristic: env-var-name patterns (`*_KEY`, `*_TOKEN`, `*_SECRET`), internal hostname patterns (`*.internal.example.com`) — configurable per org | Secrets in unusual formats, internal identifiers |
| **Semantic** | ML (opt-in per org): cheap model classifies "this snippet looks like PII" | What regex missed |
| **Fail-closed** | If a value can't be classified as safe → redact entirely + emit `SANITIZATION_FAILED` event (error category `internal`, `15` §2) | Unknown unknowns |

### Placement

Runs **at the DO → Pipelines write** (in the Worker code that constructs the analytics event). The DO has the raw data; it constructs the limited projection; Pipelines receives only the projection; ClickHouse stores only the projection. Single chokepoint; raw data never transits.

## 4. Staging copy is trivially safe

Because prod → staging (nightly, `17` §3) copies the *already-projected* ClickHouse events (which contain no raw content by construction), the staging copy needs **no re-sanitization**. The data was sanitized at the projection step in prod; staging gets a copy of the safe projection.

---

# Part B: Outbound Workers Boundary Contract

## 5. The model: per-sandbox + per-MCP manifests, deny-by-default

The Outbound Workers boundary is a programmable egress proxy where Forge injects credentials into sandbox network calls **at the edge**, so the agent never holds secrets. Its correctness depends entirely on the permissions manifest.

### What the manifest expresses

- **Egress allowlist**: which `host:port` destinations the sandbox/MCP can reach.
- **Credential injection map**: which secret (from Secrets Store) gets injected for which destination.
- **Deny by default**: anything not in the allowlist is blocked + logged.
- **Per-MCP scoping**: each MCP server gets only the allowlist *its* manifest declares (not the sandbox's whole surface).

### Sandbox manifest (from `.forge/config.toml`)

```toml
# Per-repo egress + credentials (13 §2)
[egress]
allow = [
  "registry.npmjs.org:443",
  "api.github.com:443",
  "*.internal.example.com:443"
]

[credentials]
"api.github.com" = "github_oauth:${user_id}"          # per-user cred, resolved at call time
"registry.internal.example.com" = "readonly_package_token"
```

### MCP manifest (from registry, per ADR-0007)

Each MCP server declares its own (narrower) allowlist:

```toml
# e.g., for the "linear" MCP server
[egress]
allow = ["linear-api.com:443"]

[credentials]
"linear-api.com" = "linear_token"
```

The MCP's egress is the **intersection** of its manifest and the sandbox's allowlist. An MCP can never reach more than the sandbox allows, and the sandbox's allowlist is per-repo.

## 6. Credential injection — per-call, short-TTL, never in sandbox env

The whole point of the boundary (vs just giving the sandbox a token) is that **the agent never holds the credential**.

### Mechanism

1. Agent (or MCP tool) makes an egress call (e.g., `fetch("https://api.github.com/...")`).
2. The call transits the Outbound Workers boundary.
3. The boundary checks the destination against the allowlist. If denied → block + log `boundary.egress` span with `allowed=false`.
4. If allowed, the boundary **fetches the credential from Secrets Store at that moment**, injects it into the request header, forwards to the destination.
5. The credential never touches the sandbox filesystem or env vars.

### TTL

- **Session-scoped creds** (e.g., user's GitHub OAuth for this session): TTL = session lifetime. Zeroized on session end.
- **Static creds** (e.g., read-only package token): rotated per org policy (runbook).

### Per-user creds

For destinations requiring the *user's* identity (e.g., GitHub PR creation), the boundary resolves `${user_id}` in the manifest to the session's user, fetches that user's encrypted OAuth token (master key in Secrets Store, `12` §3 `forge_user.github_oauth_token_encrypted`), decrypts, injects. The user's token is never in the sandbox.

## 7. Logging + observability

Every egress call emits a `boundary.egress` span (14 §3):

- `forge.session.id`, destination host, `allowed` (bool), `injected_credential` (name, not value), `mcp.server` (if applicable).
- Denied calls → log + emit a `BOUNDARY_EGRESS_DENIED` event (advisory — not always an error; some denials are expected MCP probing).

Suspicious patterns (many denials, attempts to denied destinations) trigger Grafana alerts.

## 8. What this prevents (threat model)

| Threat | Prevention |
|---|---|
| Agent exfiltrates secrets to external host | Egress allowlist denies non-allowlisted hosts |
| Agent uses creds destructively (Claude Code incident shape) | Creds are per-call + scoped (read-only where possible); destructive APIs not in allowlist |
| Agent reaches internal services (lateral movement) | Internal hostnames in allowlist only if explicitly added per-repo |
| MCP makes unexpected network call (supply chain) | Per-MCP scoping — MCP can only reach its declared allowlist |

## 9. What this does NOT prevent (be explicit)

- **Agent reading secrets from repo filesystem** — that's the path allowlist's job (`[paths]` sensitive in config).
- **Destructive action via an API the manifest allows** — if the manifest says "allow github.com with write token," the agent can use it destructively. Manifest correctness is the human responsibility.
- **Side channels** (timing, etc.) — out of scope for the boundary.

## 10. What this doc does NOT specify

- **Concrete Secrets Store paths/scope names** — derived during implementation.
- **Initial allowlist defaults per language/ecosystem** (npm registry, PyPI, etc.) — curated during pilot.
- **Break-glass procedure for R2 audit access** — runbook (Tier 3).
