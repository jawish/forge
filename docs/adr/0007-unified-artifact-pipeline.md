# ADR-0007: Unified artifact pipeline (MCP servers + sandbox images as OCI + governance)

**Status**: accepted

Forge does not build a bespoke "MCP registry." Instead it adopts standards for discovery and packaging, and builds **only the governance layer**. The same artifact-governance pipeline covers both registry-managed MCP servers AND sandbox images — they are the same shape of artifact (OCI images that run in CF Sandbox, needing signing/scanning/permissions).

## Why

The docs treated "MCP registry" as a thing to build. On reflection it decomposes into three problems:

1. **Discovery** — which servers exist. Solved by federating the official MCP Registry (sync to D1) + D1 for private servers.
2. **Packaging** — how an artifact is stored/versioned/signed. Solved by standardizing on OCI artifacts (cosign-signed, digest-pinned) in GHCR via KitOps ModelKits.
3. **Governance** — which servers THIS org can use for THIS repo, with what permissions, scanned how. This is genuinely Forge's to build: a D1-backed policy service (per-repo enable lists, permission manifests enforced by the Outbound Workers Boundary, OpenSSF Scorecard gating, Trivy scan at registration, cosign verification at spawn).

Building only #3 drops ~60% of the custom work and unifies with the already-locked supply-chain decisions (cosign, Trivy, Scorecard, Chainguard bases).

## Considered options

- **OCI artifacts + D1 metadata + custom permissions (no federation)** — simpler but Forge's users can't discover public MCP servers without manual addition.
- **Smithery hosted** — fastest start, but Smithery owns the governance model and Forge must fit Smithery's permission semantics.
- **Git repo of definitions (no OCI)** — weakest; loses signing/versioning/isolation semantics for the highest-risk surface.

## Consequences

- **MCP servers and sandbox images share one governance pipeline.** Browser Run / Stagehand are the exception — they're *platform-provided* MCP tools (not registry-managed); see CONTEXT.md.
- Aligns with the MCP spec's 2026-07-28 RC direction (stateless core, Extensions, MCP Apps).
- GHCR hosts both sandbox images and MCP artifacts, since the company is GitHub-centric.
