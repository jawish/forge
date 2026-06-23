# Forge — API Contracts

**Status**: Authoritative for the contract at each system seam.
**Companion docs**: `09_Project_Structure.md` (topology), `11_State_Model.md`, `12_Data_Schemas.md`, `packages/domain/` (shared types/schemas).

> Forge has six seams where data crosses a boundary. Each has a different shape and a different natural contract — **do not apply one approach everywhere**. This doc pins the contract per seam.

---

## 1. The six seams

| # | Seam | From → To | Contract | Rationale |
|---|---|---|---|---|
| 1 | **Web UI ↔ control plane** | TanStack Start (browser/server) → control-plane Worker | **tRPC v11** (fetchEdgeRequest adapter) | High-endpoint, high-iteration, same-team TS on both ends. The one seam where a framework pays off. |
| 2 | **Control plane ↔ SessionDO** | control-plane Worker → DO instance | **In-process DO method calls** (typed by `domain`) | DOs are TS classes; `env.SESSION_DO.get(id).method(args)` is a direct call, not RPC. |
| 3 | **Browser ↔ SessionDO (live)** | Browser → control-plane WS route → SessionDO | **Agents SDK Client SDK** (typed WS RPC) | Presence + reconnection native; browser must go through a Worker to reach a DO (CF constraint). |
| 4 | **External webhooks** | Slack / GitHub → control-plane Worker | **zod parsing of their schemas** | Their schema, not ours. Verify + parse; no "API design." |
| 5 | **Agent ↔ control plane** | OpenCode in Sandbox → control-plane Worker | **MCP tool calls** | OpenCode is MCP-native; callbacks exposed as platform-provided MCP tools. |
| 6 | **Ops / debugging** | curl / scripts → control-plane Worker | **Hand-rolled REST-ish routes** | Simple URLs for humans; not load-bearing. tRPC's auto-URLs suffice for most cases. |

---

## 2. Seam 1 — Web ↔ control plane (tRPC v11)

### Why tRPC (and not typed-fetch or REST/OpenAPI)

- **End-to-end types**: the tRPC router's procedure signatures ARE the client's types. No codegen step, no OpenAPI spec to keep in sync.
- **TanStack Query integration**: official `trpc-react-query` adapter — procedures become query keys, mutations, invalidation. Fits the locked TanStack Query choice.
- **CF Workers support**: official `fetchEdgeRequest` adapter works on Workers (confirmed — reference repos, production case studies).
- **Shared `domain` package**: zod schemas defined once in `packages/domain`, imported into the tRPC router as input validators. One source of truth.
- **No external API consumers**: Forge's API is internal-only; the interop benefit of REST/OpenAPI is wasted.

### Router shape

```
packages/domain/src/schemas/      # zod schemas (input/output validators)
  session.ts, prompt.ts, toolCall.ts, repo.ts, ...

apps/control-plane/src/api/       # tRPC router
  router.ts                       # root: merge(sub-routers)
  routers/
    session.ts                    # session.list, session.get, session.create, session.cancel, ...
    prompt.ts                     # prompt.submit, prompt.stream (for non-live-stream cases)
    repo.ts                       # repo.list, repo.getConfig, repo.updateConfig
    mcp.ts                        # mcp.list, mcp.enable, mcp.disable (registry governance)
    automation.ts                 # automation.list, automation.create (cron/alert triggers)
    analytics.ts                  # analytics.query (ClickHouse-backed read models)

apps/web/src/lib/trpc.ts          # tRPC client (createTRPCReact), typed by AppRouter
```

### Procedure conventions

- **Input**: every mutation/query takes a zod schema from `domain/schemas` as input. No ad-hoc types.
- **Output**: every procedure returns a typed response (also zod-validated on the server side where it matters for contracts).
- **Error handling**: tRPC's error codes (`BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `TIMEOUT`, `CONFLICT`, `INTERNAL_SERVER_ERROR`). Plus custom error codes for domain-specific failures (see `12` §error model — TODO, Tier 2).
- **Auth**: tRPC middleware checks CF Access identity (header) on every procedure. Procedures are grouped by required role (user / admin).

### Streaming (the exception)

tRPC v11 supports subscriptions (WS-based), but **live session streaming goes through seam 3** (Agents SDK Client SDK), not tRPC. tRPC is for request/response only. Don't try to make tRPC carry the live thinking stream — it's the wrong tool.

---

## 3. Seam 2 — Control plane ↔ SessionDO (in-process)

### Contract

The `SessionDO` is a TS class. The control-plane Worker calls its methods directly:

```ts
// packages/domain/src/types/sessionDO.ts
interface SessionDOInterface {
  spawn(input: SessionSpawnInput): Promise<SessionSpawnResult>
  submitPrompt(input: PromptSubmitInput): Promise<PromptSubmitResult>
  pause(): Promise<void>
  resume(): Promise<void>
  cancel(reason: CancelReason): Promise<CancelResult>
  getStatus(): Promise<SessionStatusResponse>
  // ... (full method list in 12_Data_Schemas.md §DO API)
}
```

The DO stub (`env.SESSION_DO`) is typed by this interface. No serialization framework beyond structured clone (CF's default for DO args).

### Why not RPC here

- DOs are reached via `env.SESSION_DO.get(id)` — an in-Worker call, not a network hop (from the control-plane Worker's perspective).
- Adding tRPC or any RPC framework here is pure overhead — the method signature IS the contract.

---

## 4. Seam 3 — Browser ↔ SessionDO (Agents SDK Client SDK)

### Contract

The Agents SDK Client SDK defines a typed bidirectional RPC protocol over WebSocket:

- **Server → client events**: state snapshots, thinking deltas, tool-call events, artifact events, presence updates.
- **Client → server calls**: submit prompt, pause, resume, cancel, chat message.

The browser connects to `/ws/:sessionId` on the control-plane Worker, which:
1. Authenticates the WS upgrade (CF Access identity check).
2. Forwards the connection to `env.SESSION_DO.get(sessionId).fetch(request)`.
3. The DO holds the WS open and streams events; the Client SDK on the browser handles reconnection + presence.

### Why not tRPC here

- The Client SDK is purpose-built for this path (presence, reconnection across refreshes, typed RPC).
- It's the matching client for the DO-based control plane (ADR-0004).
- tRPC subscriptions could technically do this, but reimplementing presence/reconnection is wasted effort.

### Event types (in `packages/domain/src/types/events.ts`)

Typed by the `domain` package so both the DO emitter and the browser consumer share one source of truth. Full list in `12_Data_Schemas.md`.

---

## 5. Seam 4 — External webhooks (Slack, GitHub)

### Contract

External systems send JSON to our routes. We verify + parse with zod schemas defined in `domain`:

- **Slack** (`/slack/events`): Slack Bolt SDK handles verification (signing secret) + parsing. The parsed event is typed by Bolt's types; we map to domain types.
- **GitHub** (`/github/webhooks`): verify webhook signature (GitHub App secret), parse with zod against GitHub's webhook schemas (octokit webhooks types).

No "API design" here — we conform to theirs.

---

## 6. Seam 5 — Agent ↔ control plane (MCP tools)

### Contract

OpenCode (in sandbox) calls back to the control plane via **MCP tool calls**. The control plane exposes a small set of platform-provided MCP tools:

- `forge.reportStatus(status, activity, summary)` — agent tells the control plane where it is.
- `forge.createArtifact(artifact)` — agent produces a diff/screenshot/report.
- `forge.requestHumanInput(question)` — agent asks a clarifying question (sets activity = `awaiting_input`).
- `forge.completePR(changes)` — agent signals readiness for PR creation (sets status = `ready_for_pr`).

These are **platform-provided MCP tools** (not registry-managed — see CONTEXT.md). They're implemented as an MCP server running in the control-plane Worker, reachable from the sandbox via the Outbound Workers boundary.

### Why MCP here

- OpenCode is MCP-native (ADR-0004) — exposing callbacks as MCP tools is the natural seam.
- Keeps the agent harness agnostic to Forge's internals (OpenCode doesn't import `domain`; it calls MCP tools).
- Same governance story as other MCPs (cosign-signed, etc.) — but platform-provided, so exempt from registry enable-lists.

---

## 7. Seam 6 — Ops / debugging

### Contract

Simple REST-ish routes for humans:

- `GET /api/ops/health` — liveness + readiness.
- `GET /api/ops/sessions/:id` — raw session JSON (for debugging).
- `POST /api/ops/sessions/:id/cancel` — admin force-cancel.
- `GET /api/ops/metrics` — basic counters.

These are mostly subsumed by tRPC's auto-generated URLs (tRPC procedures are reachable via plain HTTP), so this seam is "whatever's not covered by tRPC." Hand-rolled only when a human needs a memorable URL.

---

## 8. Versioning strategy

| Seam | Versioning | Why |
|---|---|---|
| Web ↔ control plane (tRPC) | **No explicit versioning** — both ends deploy together (internal platform). Breaking changes are a coordinated deploy. | We control both ends; versioning is overhead. |
| External webhooks | **N/A** — their schema, their versioning. | We conform. |
| Agent ↔ control plane (MCP) | **Semver on the MCP tool set** — adding tools is minor; changing signatures is major. Plugin-sdk is the versioned surface. | OpenCode is decoupled from control-plane deploys. |
| Browser ↔ SessionDO (Client SDK) | **Pinned to Agents SDK version** — both sides must match. | Client SDK handles compat. |

---

## 9. What this doc does NOT specify

- **Concrete tRPC procedure signatures** — derived during implementation from `packages/domain/schemas` and the user stories (`02`). The *pattern* is locked here; the *endpoints* are not.
- **Error code taxonomy** — Tier 2 (see engineering-specs roadmap).
- **Rate limiting per seam** — Tier 2.
- **Pagination conventions** — Tier 2 (cursor-based, likely).
