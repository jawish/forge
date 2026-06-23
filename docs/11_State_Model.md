# Forge — Session State Model

**Version**: 1.0 (locked)
**Status**: Authoritative for session lifecycle. Supersedes the flat status enum in `03_Architecture.md` §4.
**Companion docs**: `12_Data_Schemas.md` (where these fields live), `10_API_Contracts.md` (DO API that mutates them).

> The session state machine serves multiple consumers (dashboard, sandbox manager, cost counter, human-action prompts, analytics) that read it for **different decisions**. They need two orthogonal dimensions, not one bigger enum.

---

## 1. The two-field model

A session's state is described by **two independent fields**, not one:

| Field | Answers | Consumers | Values |
|---|---|---|---|
| **`status`** | "Where is this session in its lifecycle journey?" | Dashboard filter, analytics outcome, GitHub webhook routing, terminal-state detection | 9 (below) |
| **`activity`** | "Why is/isn't the agent progressing right now?" (only meaningful when `status === 'active'`) | Sandbox manager (hibernate/destroy?), cost counter (bill?), human-action prompts (need my input?) | 5 (below) |

### Why two fields, not one bigger enum

A session can be `status=active` (not done) AND `activity=paused` (human paused it) — both true simultaneously. A flat enum forces compound states (`active_paused`, `active_running`...) that explode combinatorially and lose the orthogonality. Two fields keep each dimension clean and independently queryable.

---

## 2. `status` — lifecycle stage

| Value | Meaning | Terminal? | Dashboard badge |
|---|---|---|---|
| `queued` | Session created, waiting for sandbox capacity / warm pool | No | grey "queued" |
| `active` | Session is in flight (check `activity` for sub-detail) | No | blue "active" |
| `ready_for_pr` | Agent finished with changes, awaiting human approval to create PR | No | amber "ready" |
| `pr_open` | PR created on GitHub, awaiting review/merge | No | blue "PR open" |
| `merged` | PR merged | **Yes (success)** | green "merged" |
| `closed` | PR closed without merge (duplicate, superseded, rejected) | **Yes (neutral)** | grey "closed" |
| `no_change` | Agent ran, decided no code change needed | **Yes (neutral)** | grey "no change" |
| `failed` | Error, stuck, or budget exhausted | **Yes (failure)** | red "failed" |
| `cancelled` | Human aborted the session (distinct from PR `closed`) | **Yes (neutral)** | grey "cancelled" |

9 values. Each is operationally distinct for lifecycle decisions.

### Key distinctions (don't conflate these)

- **`closed` vs `cancelled`**: `closed` = PR was created then closed-without-merge on GitHub. `cancelled` = human aborted the *session* (possibly before any PR). Different cause, different analytics bucket.
- **`no_change` vs `failed`**: `no_change` = agent completed successfully and decided nothing needed changing (valid outcome). `failed` = agent couldn't complete (error, budget, stuck). Both are terminal; analytics treats them very differently.
- **`queued` vs `active`**: `queued` exists because sandbox capacity isn't instant (warm pool miss, cold start). Surfacing it separately lets the dashboard show "waiting on infra" vs "agent working."

---

## 3. `activity` — current activity (only when `status === 'active'`)

| Value | Meaning | Sandbox state | Cost counter | Human action needed? |
|---|---|---|---|---|
| `provisioning` | Sandbox booting, OpenCode starting, context loading | Running (billing CPU) | No model calls yet | No |
| `running` | Agent actively looping (model + tools + edits) | Running | **Yes** (per model call) | No |
| `awaiting_input` | Agent asked a clarifying question, waiting for human | Running (keep warm) | No | **Yes** |
| `paused` | Human explicitly paused (HITL) | Hibernated (sleepAfter kicks in) | No | **Yes** |
| `stuck` | Agent looping without progress (pre-failure detection) | Running | Yes (until failover) | Optional (alert) |

5 values. Each drives a distinct operational behavior.

### How `activity` is set

- `provisioning` → set by control plane on session spawn; transitions to `running` when OpenCode emits first thinking event.
- `running` ↔ `awaiting_input` → toggled by agent's `forge.requestHumanInput` / human's prompt-submit MCP calls.
- `paused` ↔ `running` → toggled by human's pause/resume action (tRPC procedure).
- `running` → `stuck` → (`running` | `failed`) → set by the stuck-detector (loop without file edits or tool progress for N turns).

---

## 4. Transition table — `status`

Legal `status` transitions, with guards and side effects. Illegal transitions are rejected by the DO with a typed error.

| From | To | Guard (condition) | Side effect |
|---|---|---|---|
| `queued` | `active` | Sandbox provisioned successfully | Start cost counter, emit `SessionStarted` audit event, post Slack thread "started" |
| `queued` | `failed` | Provisioning failed (image pull, capacity) | Emit `SessionFailed` audit, post Slack thread "failed to start" |
| `queued` | `cancelled` | Human cancels before start | Emit `SessionCancelled` audit, no sandbox cleanup needed |
| `active` | `ready_for_pr` | Agent calls `forge.completePR` with staged changes | Snapshot sandbox, generate Review Agent artifacts (if enabled), post Slack thread "ready for review", set activity = null |
| `active` | `no_change` | Agent finishes with no staged changes | Emit `SessionCompleted` audit, post Slack thread "no changes needed", destroy sandbox |
| `active` | `failed` | Error, budget exhausted, or stuck-timeout | Emit `SessionFailed` audit (with reason), capture diagnostic snapshot, post Slack thread "failed", destroy sandbox |
| `active` | `cancelled` | Human cancels mid-session | Emit `SessionCancelled` audit, post Slack thread "cancelled", destroy sandbox |
| `ready_for_pr` | `pr_open` | Human approves PR creation (tRPC `session.approvePR`) | Create PR via user's GitHub OAuth, set `pr_url`/`pr_number`, emit `PRCreated` audit, post Slack thread "PR opened" |
| `ready_for_pr` | `active` | Human requests changes ("not ready, do more") | Restore sandbox from snapshot, set activity = `running`, post Slack thread "reopened" |
| `ready_for_pr` | `cancelled` | Human rejects | Emit `SessionCancelled` audit, destroy sandbox |
| `pr_open` | `merged` | GitHub webhook: PR merged | Emit `PRMerged` audit, capture final cost, archive session, destroy sandbox |
| `pr_open` | `closed` | GitHub webhook: PR closed without merge | Emit `PRClosed` audit, archive session, destroy sandbox |
| `pr_open` | `active` | (Optional) Reopen path: human wants more work after PR closed | Restore sandbox, set activity = `running` |

**Terminal states** (`merged`, `closed`, `no_change`, `failed`, `cancelled`): no outgoing transitions. Sandbox destroyed (or archived to R2 per retention policy). Cost counter frozen. Analytics outcome captured.

---

## 5. Transition table — `activity` (only when `status === 'active'`)

| From | To | Guard | Side effect |
|---|---|---|---|
| `provisioning` | `running` | First agent thinking event received | Mark session truly active in OTel, emit `AgentStarted` audit |
| `running` | `awaiting_input` | Agent calls `forge.requestHumanInput` | Post Slack thread "needs input", notify watchers via WS |
| `awaiting_input` | `running` | Human submits prompt (tRPC or MCP) | Clear "needs input" flag, resume streaming |
| `running` | `paused` | Human pauses (tRPC `session.pause`) | Hibernate sandbox (sleepAfter override), emit `SessionPaused` audit |
| `paused` | `running` | Human resumes (tRPC `session.resume`) | Wake/restore sandbox, emit `SessionResumed` audit |
| `running` | `stuck` | Stuck-detector triggers (no progress for N turns) | Emit `SessionStuck` metric, optionally alert on-call |
| `stuck` | `running` | Agent makes progress (file edit / successful tool call) | Clear stuck flag |
| `stuck` | (status → `failed`) | Stuck-timeout exceeded | Promotes to `status=failed` (see status table) |

---

## 6. Guards as policy (configurable per repo)

Several guards are **policy**, not hard logic — they vary by repo sensitivity:

| Guard | Default | High-sensitivity repo override |
|---|---|---|
| `active → ready_for_pr` requires Review Agent pass | Off | **On** (Review Agent mandatory) |
| `ready_for_pr → pr_open` requires human approval | **On** (always) | On + extra approval (team lead) |
| `running → stuck` threshold (turns without progress) | 10 turns | 5 turns |
| `stuck → failed` timeout | 5 min | 3 min |
| Budget exhaustion → `failed` | Per-session/user/team budget (see `08` §17) | Stricter team cap |

Policy is stored in the repo config (`.forge/config.toml` — see Tier 2 config model spec).

---

## 7. How this maps to the data model

In `12_Data_Schemas.md`:

- `SESSION.status` — enum (9 values), indexed for dashboard filtering.
- `SESSION.activity` — enum (5 values), nullable (null when `status !== 'active'`).
- `SESSION.status_history` — JSON array of `{from, to, ts, reason}` for audit/replay (cheap, append-only in DO SQLite).

The DO enforces transition legality (rejects illegal transitions with a typed `IllegalTransitionError`). The control plane never directly mutates these fields — it goes through DO methods (`session.transitionTo(status, reason)`), which validate + fire side effects atomically.

---

## 8. What this doc does NOT specify

- **Concrete stuck-detection algorithm** (heuristic, likely "N turns without file edit or successful tool call" — tuned during pilot).
- **Reopen-from-`pr_open` semantics** (the `pr_open → active` path) — marked optional; decide during pilot whether it's needed.
- **Retention policy per terminal state** (how long to keep `merged` vs `failed` sessions before archival) — Tier 2.
