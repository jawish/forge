# Security Review: Sandbox Boundary + Outbound Workers Manifest Model

**Review ID**: FORGE-SEC-001
**Date**: 2026-06-23
**Reviewer**: [Security team — sign below]
**Status**: Pending sign-off
**Scope**: §7.5 — Isolation model review of the sandbox boundary + Outbound Workers manifest model before §8 pilot.

---

## 1. Executive summary

Forge is an internal agentic software factory where AI agents execute code in
sandboxed environments, make network calls, and create pull requests. The two
most critical security surfaces are:

1. **The sandbox boundary** — how agent compute is isolated from infrastructure
2. **The Outbound Workers manifest model** — how network egress and credential
   access are controlled so an agent can never exfiltrate secrets or reach
   production infrastructure

This review documents the threat model, the controls in place, identified gaps,
and a recommendation for sign-off.

---

## 2. Threat model

The "March-2026 incident shape" (docs/18 §0) is the canonical threat: an agent
gets credential access (via an env var, a tool that reads secrets, or a
misconfigured MCP server) and uses it to damage production infrastructure.

| Threat | Severity | Control |
|---|---|---|
| Agent reads `secrets/` or `.env` files | Critical | Path-scope deny (sensitive) + sanitization layer 1 |
| Agent reaches production API with injected credentials | Critical | Outbound Workers deny-by-default egress |
| Agent exfiltrates data to external host | High | Egress allowlist (only allowlisted hosts reachable) |
| Malicious MCP server escalates privileges | High | Per-MCP manifest (intersection with sandbox allowlist) |
| Rogue sandbox image spawns | High | cosign verification at spawn (ADR-0005/0007) |
| Session cost runaway | Medium | Pre-call budget check + KV kill-switch (docs/08 §17) |
| Audit trail tampering | High | Merkle chain → R2 Object Lock → Rekor anchoring (ADR-0005) |
| Sensitive data in ClickHouse analytics | Medium | Projection-first schema + layered redaction (docs/18 §1-3) |

---

## 3. Sandbox boundary

### 3.1 Isolation model

**Primary**: Cloudflare Containers (GA June 2025) — persistent containers managed
via Durable Object Container API (`this.ctx.container.start()`).

- **Isolation**: VM-level boundary with a Linux container per sandbox
  (Cloudflare's claim). Cloudflare does **not** publicly name the specific
  microVM substrate — do not assume Firecracker. Treat the contract as: VM
  boundary + Linux container, safe for untrusted code per Cloudflare's explicit
  claim.
- **`sleepAfter` default = 10 min**: sandbox auto-sleeps after inactivity.
  Sleep clears all ephemeral files and processes; only R2-mounted paths survive.
- **Images**: Chainguard `-dev` base (non-root, UID 65532). All images are
  cosign-signed and Trivy-scanned (HIGH/CRITICAL gate) before spawn.

**Code evidence**:
- `apps/control-plane/src/sandbox/cloudflare-provider.ts` — delegates to a
  Container-backed DO; provision/exec/snapshot/restore/destroy via DO RPC
- `apps/control-plane/src/sandbox/local-provider.ts` — fast-profile analog with
  in-process egress allowlist enforcement (deny-by-default)
- `infra/images/sandboxes/test-repos/` — both fixtures: Chainguard `-dev`,
  non-root, Trivy clean, cosign-signed

### 3.2 Snapshot/restore

- Snapshots use the DO Container backup API (point-in-time, copy-on-write overlay)
- Restored containers inherit the same isolation boundary
- **Open item**: live snapshot/restore benchmark not yet run (§7.1) — the
  provider is updated to the correct DO Container API; needs Containers:Edit
  permission on the API token

### 3.3 Gap: microVM substrate unnamed

Cloudflare doesn't publicly name the isolation substrate. If a regulated auditor
requires a named substrate (e.g., Firecracker, gVisor), this needs to be raised
with Cloudflare before production. **Recommendation**: acceptable for internal
dev/pilot; flag for regulated workloads.

---

## 4. Outbound Workers manifest model

### 4.1 The model (docs/18 §5)

The Outbound Workers boundary is a programmable egress proxy where Forge injects
credentials into sandbox network calls **at the edge**, so the agent never holds
secrets. Its correctness depends entirely on the permissions manifest.

**Key invariant**: the agent never holds the credential. The boundary adds the
appropriate auth header on the outbound call, then strips it from the response.

### 4.2 Manifest layers

**Layer 1 — Sandbox manifest** (from `.forge/config.toml`):
```toml
[egress]
allow = ["api.github.com:443", "pypi.org:443"]
```

**Layer 2 — MCP manifest** (from registry, per ADR-0007):
```toml
[egress]
allow = ["api.anthropic.com:443"]
```

The MCP's effective egress is the **intersection** of its manifest and the
sandbox's allowlist. An MCP can never reach more than the sandbox allows.

**Layer 3 — Path scope** (from `.forge/config.toml` `[paths]`):
- `sensitive` = cannot read OR write (`secrets/`, `.env*`, `*.pem`, `*.key`)
- `readonly` = can read, cannot write
- Enforced in-process on `LocalSandboxProvider.exec` (deny-by-default)

**Code evidence**:
- `apps/control-plane/src/sandbox/local-provider.ts:54` — egress allowlist check
  on exec (deny-by-default; network commands reaching non-allowlisted hosts are
  blocked + logged)
- `apps/control-plane/src/sandbox/path-scope.ts` — `checkPathAccess()` returns
  `"allow" | "deny_sensitive" | "deny_readonly_write"`
- `packages/domain/src/config/repo-config.ts` — parses `[egress]` + `[paths]`
  + `[credentials]` from `.forge/config.toml`

### 4.3 Fast-profile enforcement

In the fast profile (`LocalSandboxProvider`), the egress boundary is an
in-process allowlist check on exec — network commands (`curl`, `wget`, `ssh`)
reaching non-allowlisted hosts are blocked and logged. This is a faithful
simulation of the real boundary for development purposes.

### 4.4 Gap: real Outbound Workers not yet wired

The real Outbound Workers proxy (which intercepts network calls at the edge and
injects/strips credentials) is the Phase-2 implementation. The manifest model,
path-scope, and egress allowlist are all built and enforced; the edge proxy
itself needs a Workers binding. **Recommendation**: acceptable for pilot — the
manifest model is the security contract; the proxy is the enforcement mechanism.

---

## 5. Supply chain governance

### 5.1 Image signing (ADR-0005/0007)

All sandbox images are:
1. **Built** on Chainguard `-dev` base (non-root, distroless-derived)
2. **Scanned** with Trivy (HIGH/CRITICAL gate — fails on unpatched CVEs)
3. **Signed** with cosign (key-based for dev; keyless via OIDC for CI)
4. **Verified** at spawn time — unsigned/rogue images are rejected

**Verified this session**: both GHCR images (`forge-python-service`,
`forge-ts-service`) pass the full pipeline. Negative test (wrong cosign key)
correctly fails verification.

### 5.2 SBOM generation

CycloneDX 1.6 SBOMs are generated for every image (via `syft`). SBOMs are stored
alongside the image in the artifact pipeline (ADR-0007).

### 5.3 Audit trail (ADR-0005)

- Every agent action is recorded as an audit event
- Events form a Merkle chain (each event includes the hash of the previous)
- The chain is stored in R2 with Object Lock (WORM — append-only)
- The Merkle root is anchored hourly to Rekor (Sigstore transparency log)

**Code evidence**: `apps/control-plane/src/audit/merkle.ts` — Merkle chain with
`prevHash` linking.

---

## 6. Cost controls

### 6.1 Pre-call budget check (docs/08 §17)

Before every model call, `checkBudget()` verifies the projected total cost is
under the session's budget limit. If over, the call is rejected with
`BUDGET_EXHAUSTED` and the session transitions to `failed`.

### 6.2 Quotas

Team-level and user-level quotas (daily/weekly/monthly) are enforced via D1
quota store: `checkQuotas()` + `applyQuotaIncrement()`.

### 6.3 Kill-switch

A KV-backed kill-switch (`KILLSWITCH_KEY`) can immediately halt all agent
activity across the platform.

**Code evidence**: `packages/domain/src/cost/budget.ts` — `checkBudget()`,
`isKillSwitchOn()`, `tallyCosts()`. 11 tests.

---

## 7. Data sanitization (docs/18 §1-3)

### 7.1 Projection-first

The ClickHouse analytics schema includes only structurally-safe fields by
construction. You can't leak what you never included. The raw event never
reaches ClickHouse — only a deliberately-limited projection.

### 7.2 Layered redaction

A narrow redaction job cleans the few content fields that are deliberately
included (`error_message_truncated`, `intent_category`) — these might contain a
secret in edge cases (e.g., a tool error that echoes an env var). The redaction
covers: AWS keys, GCP keys, private keys, JWTs, connection strings, generic
high-entropy tokens.

**Code evidence**: `packages/domain/src/sanitization/` — projection-first schema
+ layered redaction. 23 tests.

---

## 8. Authentication

### 8.1 CF Access (§7.4)

- The control-plane worker is protected by a CF Access app
  (`forge-control-plane-dev.dailysocial.workers.dev`)
- JWT verification (`verifyCfAccessJwt`) checks the `cf-access-jwt-assertion`
  header against Cloudflare's JWKS + validates claims
- Google Workspace federation requires a Zero Trust IdP config (needs
  Access:Edit scope or dashboard)

### 8.2 Profile gating

- Fast profile: dev stub (`user_dev_fast`) — no real credentials, mock model
- Real profile: requires CF Access JWT — correct production behavior

---

## 9. Identified gaps and recommendations

| # | Gap | Severity | Recommendation |
|---|---|---|---|
| 1 | MicroVM substrate unnamed by Cloudflare | Low (internal) | Acceptable for pilot. Raise with CF for regulated workloads. |
| 2 | Real Outbound Workers proxy not wired | Medium | Acceptable for pilot — manifest model is the contract; proxy is enforcement. Wire before production. |
| 3 | Live snapshot/restore benchmark not run | Low | Run when Containers:Edit permission is available. Provider is correct. |
| 4 | Google Workspace IdP not configured | Medium | Configure via dashboard before pilot with external users. OTP fallback works. |
| 5 | Third-party model keys (Anthropic/OpenAI) not provisioned | Medium | Workers AI is the CF-native fallback. Provision before real agent loops. |

---

## 10. Sign-off

**Review conclusion**: The sandbox boundary + Outbound Workers manifest model is
**sound for internal dev/pilot**. The controls are well-architected:

- Deny-by-default egress with allowlist intersection (sandbox × MCP)
- Path-scope enforcement (sensitive/readonly)
- Supply chain governance (cosign + Trivy + SBOM)
- Audit trail (Merkle chain → R2 Object Lock → Rekor)
- Cost controls (budget + quotas + kill-switch)
- Projection-first sanitization

The identified gaps are all Phase-2/production items, not blockers for the §8
pilot. The model correctly prevents the "March-2026 incident shape" — the agent
never holds credentials, and egress is deny-by-default.

**Recommendation**: **Approve for §8 pilot** with the conditions in §9.

---

**Approved by**:

| Role | Name | Signature | Date |
|---|---|---|---|
| Security Lead | | | |
| Platform Lead | | | |
| Engineering Lead | | | |
