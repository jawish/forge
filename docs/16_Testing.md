# Forge — Testing Strategy

**Version**: 1.0 (locked)
**Status**: Authoritative for test layering, mocking conventions, and CI gate policy.
**Companion docs**: `08_Tech_Stack.md` §9 (Vitest + Playwright), `09_Project_Structure.md` (local dev profiles).

> Forge is a glue-heavy system — bugs live at seams, not in pure logic. An integration-heavy test shape (seam tests with mocked externals) catches the bugs that matter. The unit-heavy pyramid is wrong for this system.

---

## 1. Test shape — integration-heavy ("testing trophy")

| Layer | % of tests | Tool | What's real | What's mocked |
|---|---|---|---|---|
| **Pure unit** | ~15% | Vitest | The function under test (pure logic in `domain/`: zod schemas, state-machine transitions, error mapping, sanitization redactors) | Everything else |
| **Seam tests** | ~80% | Vitest + miniflare | The seam under test (tRPC router + DO, OpenCode harness + mock model, sanitization pipeline, state machine against real DO) | Externals beyond the seam: R2, D1 (miniflare-emulated), real model, real sandbox |
| **E2E** | ~5% | Playwright | Full browser → web Worker → control-plane Worker → DO → mock sandbox | Real model + real sandbox (mocked) |

**Real-model / agent-behavior tests**: staging only. Never in CI (non-determinism doesn't belong in CI).

### Why integration-heavy

Forge's bugs are overwhelmingly:
- **Seam bugs** (tRPC router sends wrong shape; DO method signature drifted; MCP tool error unhandled; WS event mismatch)
- **State-machine bugs** (illegal transition allowed; side effect fires twice; stuck-detector misfires)
- **Agent-loop bugs** (harness doesn't pass right context; streaming UX drops events)
- **Contract drift** (zod schema ≠ what frontend sends)

Pure unit bugs (a function returns wrong value) are rare. A unit-heavy pyramid over-tests trivial functions and misses seam drift.

### The "seam test" definition

A seam test exercises the real seam under test with externals mocked *at the boundary*:
- **tRPC router + DO**: real Worker runtime (miniflare), real DO SQLite, mocked R2/D1 bindings.
- **OpenCode harness + model**: real OpenCode loop, mock model returning canned fixture responses (deterministic).
- **Sanitization pipeline**: real sanitizer code, realistic-but-fake input data.
- **State machine**: real DO instance, real transition logic.

**Mocking convention**: mocks live at the *external boundary* (R2, D1, real model, real sandbox), never at internal seams. Internal seams are always exercised for real — that's what makes seam tests valuable.

---

## 2. Test fixtures

| Fixture type | Where | Purpose |
|---|---|---|
| **Canned model responses** | `apps/control-plane/src/test/fixtures/model-responses/` | JSON files of streamed model outputs (thinking deltas, tool calls, completions). Deterministic inputs for seam tests. |
| **Sample repos** | `infra/images/sandboxes/test-repos/` | Minimal fake repos (Python, TS) with `.forge/config.toml`, for sandbox/image-build tests. |
| **Sanitization corpus** | `packages/domain/src/test/fixtures/sanitization/` | Pairs of (raw, expected-sanitized) for the redaction tests. Grows as new patterns are discovered. |
| **State-machine scenarios** | `apps/control-plane/src/test/fixtures/state-scenarios/` | Sequences of transitions (happy path, cancel-mid-flight, stuck-recovery, etc.). |
| **Slack event payloads** | `apps/control-plane/src/test/fixtures/slack-events/` | Realistic Slack Events API payloads (mention, reaction, thread reply). |

---

## 3. Testing the hard things

### Durable Objects

Use **miniflare** (workerd's local runtime, bundled with wrangler). It emulates DOs + SQLite + bindings (R2, D1, KV, Queues) locally. Tests instantiate the DO via miniflare's `DurableObjectStub`, call methods, assert on SQLite state.

```ts
// Example seam test shape
const env = await getMiniflareBindings();  // real DO + emulated R2/D1/KV
const doStub = await env.SESSION_DO.get(id);
await doStub.spawn({ repoId, branch, ... });
const status = await doStub.getStatus();
expect(status.status).toBe('active');
```

### OpenCode harness integration

Run **real OpenCode** against a **mock model** that returns canned streaming responses. Tests that the harness:
- Passes the right context (system prompt, tools, history).
- Handles tool errors per the error contract.
- Streams events the Client SDK expects.
- Calls platform MCPs (`forge.reportStatus`, etc.) at the right moments.

Mock model is a small server implementing the OpenAI-compatible chat-completions API, returning fixtures from `model-responses/`.

### CF Sandbox

In `fast` dev profile (09 §5), the `LocalSandboxProvider` runs commands in a local subprocess — same interface, real execution. Tests use this. Real CF Sandbox is exercised in `real` profile + staging.

### Agent loop (end-to-end)

E2E tests (Playwright) drive the full browser → web → control-plane → DO → mock-sandbox path for ~5 critical user journeys. Real model is mocked (canned fixtures). These catch seam issues across all the boundaries but are slower/flakier — hence advisory in CI.

---

## 4. CI gate policy — risk-allocated

Strict on deterministic high-value tests; lax on non-deterministic / low-value ones.

### Blocking (must pass before merge to main)

- `tsc` typecheck (TS 7)
- `Oxlint` (lint + format check)
- **All pure unit tests** (`domain/`)
- **All seam tests** (tRPC router + DO, harness + mock model, sanitizer, state machine)

### Advisory (runs on PR, non-blocking)

- E2E (Playwright) — except ~5 critical paths which ARE blocking:
  - Login (CF Access flow)
  - Create session
  - View session (live stream connects)
  - Submit prompt
  - Cancel session

### Staging-only (never in CI)

- Real-model tests (non-deterministic; provider quirks)
- Agent-behavior tests (real provider calls)
- Full session-lifecycle dogfooding

### Tiered by package

| Package | Gate |
|---|---|
| `apps/control-plane` + `packages/domain` | Full strict gate (seam bugs live here) |
| `apps/web` | typecheck + lint + unit + advisory E2E (UX iteration speed matters more) |
| `packages/plugin-sdk` | typecheck + lint + unit |
| `infra/*` | lint + validate (Pulumi preview, Dockerfile lint) |

### Branch protection

- Green strict gate + 1 reviewer required for merge to `main`.
- Staging deploys from `main` on merge.
- Prod deploys require a tagged release + 2-person approval (GitHub Actions environment protection).

---

## 5. Local dev test running

- `mise test` — runs all unit + seam tests (Vitest).
- `mise test:unit` — unit only (fastest).
- `mise test:e2e` — Playwright (requires `fast` or `real` profile running).
- `mise test:watch` — Vitest watch mode for inner-loop iteration.

Tests run against the `fast` profile by default (mocks, no external deps). Real-model tests require explicit `FORGE_DEV_PROFILE=real` + dev-shared creds.

---

## 6. What this doc does NOT specify

- **Coverage thresholds** — set pragmatically during pilot; high coverage of trivial functions is waste.
- **Performance benchmarks** — separate concern (Tier 3: SLOs).
- **Load testing** — staging-only, with synthetic load.
- **Mutation testing / property-based testing** — opt-in tools, not baseline.
