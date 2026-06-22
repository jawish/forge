# ADR-0001: All-Cloudflare primary strategy

**Status**: accepted

Forge runs on Cloudflare as its sole cloud, using Sandbox (compute), AI Gateway (model abstraction), Browser Run (visual verification), R2/D1/KV/Vectorize (storage), and Queues/Workflows (async) as the primary stack — rather than Modal/Daytona for sandbox and LiteLLM/OpenRouter for model routing, as the original docs proposed.

## Why

Cloudflare's Agents Week 2026 (April) shipped native equivalents of nearly every "TBD" component in the docs. Going all-CF gives a single bill, single observability plane, native low-latency integration between control plane ↔ sandbox ↔ model calls, and — most importantly — the **Sandbox Outbound Workers credential-injection boundary**, which is the canonical implementation of the security model the docs described but had no concrete answer for. The March 2026 Claude Code incident (deleted prod DB + snapshots) was a *credential-access* failure, not an isolation failure; the Outbound Workers boundary is exactly the mitigation.

## Considered options

- **Modal primary + CF secondary** — Modal's snapshot-restore speed is industry-leading and battle-tested for coding agents, but cross-provider networking/ops complexity outweighed the benefit once CF Sandbox shipped native.
- **CF primary + portable interface + Daytona secondary from day 1** — full provider portability, but meaningful upfront engineering for a benefit that may never be needed.

## Consequences

- **Accepted lock-in** on the sandbox and model-abstraction layers. This directly contradicts the original docs' stated goal of multi-provider abstraction for failover.
- Mitigated by a **thin sandbox-provider interface** with Daytona as a *documented* (not built) failover path — if CF Sandbox materially underperforms or pricing changes, the interface is the swap point.
- CF Sandbox's snapshot/restore capability vs Modal's is still being verified; if it falls short for warm-start performance, the failover weighting toward Daytona may need to become real (not documented-only).
