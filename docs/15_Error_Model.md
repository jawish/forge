# Forge — Error Model

**Version**: 1.0 (locked)
**Status**: Authoritative for the error contract across all seams.
**Companion docs**: `10_API_Contracts.md` (per-seam integration), `12_Data_Schemas.md` (DO API).

> Don't design an error *taxonomy* (they rot). Design the error *contract*. Categories are decision-types (7 of them), not failure-modes. Domain-specific codes grow organically from real failures.

---

## 1. The contract

Every error crossing a seam carries these fields:

```ts
type ForgeError = {
  category: ForgeErrorCategory;     // drives consumer decisions (render-what / retry / act / page)
  retryable: boolean;                // derived from category but explicit per-context
  message: string;                   // human-readable, safe to show users (no secrets)
  correlationId: string;             // OTel trace id — always present
  code?: string;                     // optional domain-specific code for grep (grows organically)
  details?: unknown;                 // typed per-code, optional (budget details, transition attempted, etc.)
};

type ForgeErrorCategory =
  | 'auth'               // token expired, not allowed
  | 'not_found'          // session/repo/config doesn't exist
  | 'invalid_input'      // bad prompt, invalid config, illegal transition
  | 'budget_exhausted'   // cost limit hit
  | 'transient'          // provider timeout, sandbox capacity, rate limit
  | 'upstream_failure'   // AI Gateway 5xx after retries, GitHub down
  | 'internal';          // unexpected exception, bug
```

### Why categories, not codes

Consumers (UI, agent, on-call, auto-recovery) make decisions based on ~7 categories, not 50 codes. Categories are stable (they're decision-types); codes grow organically as real failures get names. Every consumer's decision is derivable from the category + retryable flag.

---

## 2. The 7 categories

| Category | Retryable? | Examples | Consumer action |
|---|---|---|---|
| `auth` | No | Token expired, not allowed | Redirect to login / show "needs permission" |
| `not_found` | No | Session/repo/config doesn't exist | Show 404 / agent gives up that approach |
| `invalid_input` | No | Bad prompt, invalid config, illegal transition | Show validation error / agent asks human |
| `budget_exhausted` | No | Cost limit hit | Show "over budget" / fail session |
| `transient` | **Yes** | Provider timeout, sandbox capacity, rate limit | Auto-retry with backoff |
| `upstream_failure` | Maybe | AI Gateway 5xx after retries, GitHub down | Retry once then surface / failover provider |
| `internal` | No | Unexpected exception, bug | Show "something broke" + correlationId; page on-call |

---

## 3. Domain codes (organic, not enumerated up front)

Codes are grep labels for investigating *known* failures. Don't enumerate all codes up front — add them when a real failure pattern emerges and gets a name. Initial seed (will grow):

| Code | Category | Meaning |
|---|---|---|
| `BUDGET_EXHAUSTED` | budget_exhausted | Session/user/team budget hit |
| `ILLEGAL_TRANSITION` | invalid_input | State-machine transition rejected (11 §4) |
| `SANDBOX_PROVISIONING_FAILED` | transient/upstream_failure | Image pull failed, capacity unavailable |
| `STUCK_TIMEOUT` | internal | Stuck-detector timeout (11 §5) |
| `SANITIZATION_FAILED` | internal | Value couldn't be classified as safe (18 §3) |
| `PROVIDER_ERROR` | upstream_failure | AI Gateway upstream failed after retries |
| `CONFIG_VALIDATION_FAILED` | invalid_input | `.forge/config.toml` invalid (13 §5) |
| `GIT_IDENTITY_ERROR` | auth | PR creation failed — token expired, perms |

This list is not exhaustive. Add codes as failures emerge; don't pre-design the taxonomy.

---

## 4. Seam integration

Each seam (10 §1) implements the contract:

### tRPC (Web ↔ control-plane)

Map category → tRPC error code; carry the rest in `data`:

| Category | tRPC code |
|---|---|
| `auth` | `UNAUTHORIZED` |
| `not_found` | `NOT_FOUND` |
| `invalid_input` | `BAD_REQUEST` |
| `budget_exhausted` | `PRECONDITION_FAILED` |
| `transient` | `TIMEOUT` |
| `upstream_failure` | `INTERNAL_SERVER_ERROR` |
| `internal` | `INTERNAL_SERVER_ERROR` |

The tRPC client reads `data.category`, `data.retryable`, `data.correlationId`, `data.code` to drive UX.

### MCP tools (agent ↔ control-plane)

Agent-facing tool errors return `{category, retryable, message}` (no internal stack, no secrets). The agent loop uses `category` + `retryable` to decide:
- `transient` + retryable → retry with backoff
- `invalid_input` → ask human for clarification
- `auth` / `not_found` → give up that approach, try different
- `budget_exhausted` → terminate session gracefully

### User-facing (Slack / web toast)

Always include `message` + `correlationId`. Format: *"Error XYZ123: {message}. Share code XYZ123 with support."*

### Auto-recovery

- `transient` → retry with exponential backoff (max 3 retries at the seam boundary).
- `upstream_failure` → one retry, then surface; for provider errors, failover to next provider in the tier (AI Gateway fallback config).
- Non-retryable → surface immediately, no retry.

---

## 5. Error logging to ClickHouse

Every error (transport + domain) emits a structured event to ClickHouse via Pipelines:

```json
{
  "event_type": "error",
  "ts": 1719100000000,
  "session_id": "sess_abc",
  "category": "transient",
  "code": "SANDBOX_PROVISIONING_FAILED",
  "message": "Sandbox image pull timed out",
  "correlation_id": "trace_xyz",
  "retryable": true,
  "actor_id": "user_123",
  "service": "forge-control-plane"
}
```

On-call's primary triage tool: filter by `category`, drill into `code`, trace via `correlation_id`.

---

## 6. What this doc does NOT specify

- **Per-procedure error cases** (which specific errors each tRPC endpoint can return) — derived during implementation.
- **Retry budgets per provider** — tuned during pilot.
- **Alert routing** (which errors page on-call) — Tier 3 operational concern.
