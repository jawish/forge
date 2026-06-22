# ADR-0003: TanStack Start over Next.js

**Status**: accepted

Forge's web UI is built on **TanStack Start** (deployed to Cloudflare Workers via the official Vite plugin), not Next.js as every prior Forge doc assumed.

## Why

TanStack Start gives a type-safe, full-stack framework built on TanStack Router + Vite + Vinxi/Farrassa server runtime, with first-class Cloudflare Workers deployment (officially endorsed by Cloudflare, with production migration case studies). It pairs naturally with the rest of the chosen TanStack stack (TanStack Store/Query/Form for client state), and its type-safety-first philosophy matches the codebase's TypeScript-7-strict posture. Next.js's Server Actions and App Router conventions added conceptual overhead that wasn't paying for itself in a closed internal platform.

## Considered options

- **Next.js App Router on Cloudflare Pages or Workers (OpenNext)** — the industry default and what the docs assumed. Rejected because the type-safety story is weaker than TanStack's end-to-end typed routing, and the Vite DX is materially faster.
- **Next.js on Vercel** — adds a second vendor to the runtime path; rejected given the all-CF strategy.

## Consequences

- Smaller ecosystem than Next.js; fewer copy-paste examples for niche problems. Mitigated by TanStack's active maintenance and Cloudflare's endorsement.
- Realtime browser→server transport still goes through the standard CF pattern (browser → Worker auth-proxy → Durable Object). TanStack Start's Worker handles HTTP + app serving; a dedicated session-gateway Worker (service binding) handles the WS upgrade to the DO. Two Workers, one Pulumi deployment unit.
