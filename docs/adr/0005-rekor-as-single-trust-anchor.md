# ADR-0005: Rekor as the single trust anchor

**Status**: accepted

Sigstore's **Rekor** transparency log is Forge's single public source of truth for cryptographic verification — anchoring both (a) hourly Merkle roots of the Audit Event chain and (b) signatures of OCI Artifacts (sandbox images, registry-managed MCP servers). Audit integrity and supply-chain provenance, usually separate concerns, share one trust anchor.

## Why

Rekor was already locked for image signing (supply-chain decision). Reflecting on the audit-log requirement (SOC2-grade tamper-evident logging of every agent action), the elegant move was to anchor the audit Merkle chain to the *same* transparency log. This gives a coherent security story for auditors — *"we don't ask you to trust our infrastructure; verify against the public Merkle root"* — and reuses infrastructure rather than adding a vendor.

## Considered options

- **R2 Object Lock alone (WORM), no external anchor** — protects against a DB-level compromise but not a CF-account-level compromise (an attacker with account takeover could alter R2 without the Rekor check catching it).
- **External audit SaaS (Panther, Lacework)** — strongest out-of-box compliance story but adds a vendor for something composable from locked components.

## Consequences

- The canonical immutable audit trail is **R2 Object Lock (Compliance mode) + Merkle hash chain anchored hourly to Rekor**; ClickHouse holds a queryable copy for compliance searches, re-derivable from R2 for integrity verification.
- CF Pipelines streams audit events to both R2 (immutable) and ClickHouse (queryable) in one pipeline.
- Rekor becomes the unified verification surface for three concerns: image authenticity, audit integrity, and MCP registration proofs.
