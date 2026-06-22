# ADR-0006: TypeScript 7-native (RC) with TS 6 fallback

**Status**: accepted

Forge's codebase targets **TypeScript 7** (the Go-native compiler) as the primary toolchain, with TypeScript 6.x (JS-based) documented as a clean fallback. Linting uses **Oxlint** (stable) and formatting uses **Oxfmt** (beta, with Prettier as fallback if it blocks).

## Why

TypeScript 7.0 RC shipped June 18, 2026 with ~10× faster type-checks and ~8× faster language service (Microsoft's words: "real, stable, and ready for broader use"). Oxlint reached stable and is ~40× faster than ESLint+Prettier in real migrations. For a TS-heavy monorepo (control plane, web UI, plugins, sandbox tooling), the compounding DX win is substantial. The trajectory is clearly toward GA within the implementation window.

## Considered options

- **TypeScript 6.x + ESLint + Prettier (the safe default)** — zero early-adoption risk. Rejected because the speed regression compounds daily across the team and the migration path later is the same as adopting now.
- **TypeScript 7 GA only (wait)** — would mean shipping Phase 0 on TS 6 anyway; the RC is explicitly scoped for broader use.

## Consequences

- **Calculated early-adoption risk.** TS 7 is RC (not yet GA-stable); Oxfmt is Beta. This is a deliberate bet on the trajectory, documented as such — not a silent risk.
- Fallback is clean: TS 6.x is maintained in parallel by Microsoft; Prettier is a drop-in if Oxfmt blocks. The codebase avoids TS-7-only syntax features that would block fallback.
- Tooling versions are pinned in the monorepo and tracked in the upgrade path.
