// @forge/domain — the shared spine. One package, four concerns (docs/09 §2):
//   types/   plain TS types (docs/11, 12, 10)
//   schemas/ zod runtime validators (the tRPC/MCP input contracts — docs/10 §2)
//   otel/    the forge.* namespace, span/service names, ClickHouse DDL (docs/14, 12 §5)
//   config/  .forge/config.toml repo-config schema + TOML parser (docs/13)
// Plus errors (docs/15) and the state machine (docs/11).
//
// Pure TS, zero runtime deps except zod + smol-toml. Fully unit-tested (§3.9).

export * from "./types/index";
export * from "./schemas/index";
export * from "./otel/index";
export * from "./config/index";
export * from "./errors/index";
export * from "./state/index";
export * from "./sanitization/index";
export * from "./cost/index";
export * from "./model-router";
export * from "./onboarding";
export * from "./review-agent";
export * from "./model-eval";
