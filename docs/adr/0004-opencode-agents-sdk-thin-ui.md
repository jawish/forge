# ADR-0004: OpenCode + Agents SDK + thin UI (no TanStack AI, no Flue)

**Status**: accepted

The agent stack is three layers: **OpenCode** (in-sandbox harness, MCP-native) + **Cloudflare Agents SDK + Client SDK** (control-plane transport, presence, reconnection) + **thin typed React rendering** on top of the Client SDK's events. TanStack AI and Flue were both considered and rejected.

## Why

The four candidate frameworks (Cloudflare Agents SDK, TanStack AI, Pi, Flue) sit at **different layers** and aren't interchangeable:

- **Cloudflare Agents SDK** = control-plane runtime + transport (DO-based, WS hibernation, Client SDK with presence + reconnection). Already locked because the control plane is DO-based. The browser MUST go through a Worker to reach a DO (CF security constraint), and the Client SDK is purpose-built for that path.
- **TanStack AI** = UI streaming layer speaking the AG-UI protocol. Valuable for provider/portable agent UIs; wasted in a closed internal platform where one transport and one provider layer (AI Gateway) already exist. Adopting it would require an AG-UI ↔ Agents-SDK bridge with no payoff. **Confirmed by research (Jun 2026):** the Cloudflare Agents SDK does not natively emit AG-UI (open feature request `ag-ui-protocol/ag-ui#655`), and no documented example exists of the TanStack AI + Agents SDK combination — adopting it would make Forge the reference implementation for an undocumented bridge.
- **Flue / Pi** = in-sandbox harnesses competing with OpenCode. OpenCode wins as a server *designed to be driven programmatically by an external control plane* — exactly Forge's shape — and is MCP-native (matches the OCI/artifact governance locked in ADR-0007). Flue (Astro team, 1.0 Beta as of Jun 2026) is a credible future alternative and is the first framework explicitly targeting the Agents SDK, but it is younger, Experimental, and — critically — **does not expose itself as an MCP server** (it consumes MCP, doesn't serve), which breaks the programmatic-control pattern Forge depends on.

## Considered options

- **Flue + Agents SDK + TanStack AI** — all three modern TS frameworks together. Rejected because Flue is a newer framework with more build/ramp risk than OpenCode's proven programmatic-control surface, and the TanStack AI AG-UI bridge is overhead here.
- **OpenCode + Agents SDK + TanStack AI (build the AG-UI bridge)** — future-proofs against the AG-UI standard. Rejected as premature for an internal platform; can be revisited if Forge ever productizes.

## Consequences

- The UI rendering layer is hand-rolled but thin — it consumes typed events from the Client SDK. If AG-UI becomes a hard requirement (e.g., third-party UI integration), the seam to add an AG-UI emitter is well-defined.
- OpenCode is the harness; Browser Run / Stagehand are exposed as **platform-provided MCP tools** (not registry-managed — see CONTEXT.md).
