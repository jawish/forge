# Forge — Integration & Extension Contracts

**Status**: Authoritative for Slack classifier logic + OpenCode/MCP extension model.
**Companion docs**: `08_Tech_Stack.md` §11/§13 (Slack bot, MCP governance), `10_API_Contracts.md` (seam 4 + 5), `12_Data_Schemas.md` (mcp_server table).

> Two integration surfaces locked here: how the Slack classifier decides what to spawn, and how the agent-extension ecosystem works (one seam: MCP).

---

# Part A: Slack Classifier

## 1. Two-stage classification

A Slack mention could be a real coding request, or noise ("thanks @forge"). The classifier makes **two distinct decisions** with **two distinct models**:

### Stage 1: Intent filter (cheap model, tier 5)

**Decides**: is this a coding-task request worth spawning for?

- Input: the Slack message text + thread context.
- Output: `is_coding_task` (bool) + `confidence` (0-1).
- Rejects: thanks, jokes, questions-about-Forge, non-coding asks.
- Model: cheap classifier (tier 5 — `08` §6).

If `is_coding_task = false` or `confidence < 0.5`: respond with a helpful non-action message ("I help with coding tasks — mention me with a code change request"). Don't spawn.

### Stage 2: Repo router (Workers AI embeddings → Vectorize)

**Decides**: which repo does this task target?

- Input: the message text (if stage 1 passed).
- Embed the prompt via Workers AI → query Vectorize → top-K candidate repos with similarity scores.
- Output: ranked candidate repos with scores.

## 2. Tiered confidence policy

The router's output is then acted on per confidence tier. **Never silently pick a low-confidence guess.**

| Tier | Condition | Action |
|---|---|---|
| **High** | Top repo score > 0.8 AND margin over #2 > 0.2 | **Auto-spawn**. Post "started session on `{repo}`" to thread. |
| **Medium** | Top repo score 0.5–0.8 OR margin < 0.2 | **Confirm**. Post "Did you mean `{top_repo}`? React ✅ to confirm." Spawn on reaction. |
| **Low / tie** | Top score < 0.5 OR 3+ repos within margin | **Disambiguate**. Post list of top 3 candidates: react with the matching repo emoji. |
| **No match** | All scores < 0.3 | **Explain**. Post "I couldn't figure out which repo — specify with `in <repo-name>`." |

### Asymmetric failure modes

- **False positive** (wrong-repo spawn) → wastes money + annoys. Mitigated by the medium/low tiers.
- **False negative** (fail to spawn) → makes Forge feel broken. Mitigated by the low threshold (0.3) + helpful "how to specify" message.

## 3. Multi-repo prompts

If the message genuinely references multiple repos ("fix the bug in checkout and update the docs in marketing-site"), the router returns multiple high-confidence matches. Forge spawns **one session per repo** (sessions are per-repo by definition — `11` §1) and posts a thread message listing both.

## 4. Slack routing details

- **Trigger**: `@forge` mention OR reaction (📌) on a message.
- **Thread**: all Forge responses go in the same Slack thread as the trigger.
- **Dedup**: if a session is already running for the same `(repo, branch, slack_thread)` tuple, don't spawn a duplicate — post a link to the existing session instead.
- **Update cadence**: status transitions post to the thread (started, ready_for_pr, failed, merged).

---

# Part B: Extension Model — One Seam (MCP)

## 5. The single extension surface

There are three *possible* extension surfaces in a system like Forge, but only one is the extension point:

| Surface | What | Extensible? |
|---|---|---|
| **#1 Agent tools** (what the agent can do in a session) | A new capability: query Linear, run a linter, access an internal API | **Yes — via MCP** |
| **#2 Harness behavior** (how OpenCode loops) | Custom stuck-detection, custom context management, a custom sub-agent | **No — Forge-internal** |
| **#3 Control plane behavior** (how Forge orchestrates) | New automation, new entry surface, new analytics view | **No — Forge-internal** |

All third-party extension happens at **surface #1 (the MCP layer)**. The harness and control plane are Forge-internal code; if extension is ever needed there, it's a code change, not a plugin API.

## 6. Why MCP-only

- **One extension surface** = simpler story for contributors ("write an MCP server, register it, done").
- **One governance pipeline** (ADR-0007): every extension goes through OCI + cosign + Scorecard + per-repo enable-list + permission manifest + Outbound-Workers scoping.
- **One security boundary**: every extension is sandboxed + permission-manifested.
- **No coupling to OpenCode internals**: the MCP layer is the contract; OpenCode is a consumer. OpenCode can be swapped for Flue (or whatever's next) without touching the extension ecosystem.

## 7. OpenCode integration — configure, don't fork

Forge does NOT write a custom OpenCode plugin or fork OpenCode. Integration is via:

1. **OpenCode's MCP-consumer config**: at session spawn, the control plane writes an OpenCode config listing the MCP servers for this session:
   - **Platform-provided MCPs** (always available): `forge.reportStatus`, `forge.createArtifact`, `forge.requestHumanInput`, `forge.completePR`, Browser Run, Stagehand.
   - **Registry-managed MCPs** (per-repo allowlist from `.forge/config.toml` `[mcp]` allowlist).
2. **OpenCode starts, consumes those MCP servers as tools.** No custom plugin code.
3. **Lifecycle signals**: the agent calls `forge.reportStatus` (a platform-provided MCP tool) to signal state — that's the lifecycle seam, not a harness hook.

**Upgrades stay clean**: OpenCode version bumps don't break Forge because Forge doesn't touch OpenCode internals.

## 8. Platform-provided MCP tools (first-party)

These are **Forge-written MCP servers** that go through the same MCP seam. They're exempt from the registry enable-list (they're always available, per CONTEXT.md "MCP platform-provided") but follow the same permission-manifest pattern.

| MCP tool | Purpose | Calls back to |
|---|---|---|
| `forge.reportStatus` | Agent tells control plane its activity + summary | DO `reportStatus` (12 §2) |
| `forge.createArtifact` | Agent produces a diff/screenshot/report | DO `createArtifact` |
| `forge.requestHumanInput` | Agent asks a clarifying question (sets `activity=awaiting_input`) | DO `requestHumanInput` |
| `forge.completePR` | Agent signals readiness for PR (sets `status=ready_for_pr`) | DO `completePR` |
| `browser.run` | Browser Run wrapper — agent visual verification (08 §12) | Browser Run API |
| `stagehand.act` | Stagehand wrapper — cached/repeatable Playwright actions | Stagehand |

These are exposed as a single MCP server running in the control-plane Worker, reachable from the sandbox via the Outbound Workers boundary (with the platform-MCP egress manifest).

## 9. Registry-managed MCP tools (third-party)

Third-party MCP servers from the registry (ADR-0007):

- **Discovery**: federated from official MCP Registry + private entries in D1.
- **Packaging**: OCI artifacts (cosign-signed) in GHCR via KitOps ModelKits.
- **Governance**: per-repo enable list, permission manifest (per the Outbound Workers boundary, §Part B of `18`), Scorecard gating, Trivy scan at registration, cosign verify at spawn.
- **Authoring**: via `packages/plugin-sdk`.

## 10. `packages/plugin-sdk` — the MCP author SDK

**Purpose**: the SDK for writing registry-managed MCP servers that work with Forge's governance pipeline.

**Not for**: OpenCode plugins (there is no OpenCode plugin story — configure via MCP). Not for control-plane extension.

**What it provides**:

- **Typed tool definitions** matching `packages/domain` types — so MCP tool args/results are type-safe end-to-end.
- **Permission-manifest declaration helpers** — declarative syntax for the Outbound Workers egress allowlist + credential requirements (so the manifest is generated from the same source as the tool code).
- **Cosign-signing build helpers** — the OCI build pipeline signs the MCP server image as part of `pnpm build`.
- **Scorecard-optimized repo template** — the SDK scaffolds a repo structure that scores well on OpenSSF Scorecard (tests, CI, signed releases, etc.) for registry gating.

**Consumers**:
- Internal teams writing company-specific MCPs (e.g., "query our internal service X").
- OSS authors writing public MCPs for the official Registry.
- Vendors distributing MCPs.

**Published** to npm separately from the platform (`pnpm publish`, semver) — external consumers depend on it without needing the whole Forge monorepo.

---

## 11. What this doc does NOT specify

- **Concrete MCP tool schemas** (args/results for each tool) — derived during implementation from `domain` types.
- **Plugin-sdk API surface** (specific helpers, types) — designed when the first non-trivial MCP is built (just-in-time, not speculative).
- **Slack classifier model tuning** (exact thresholds, Vectorize indexing strategy) — tuned during pilot with real Slack data.
