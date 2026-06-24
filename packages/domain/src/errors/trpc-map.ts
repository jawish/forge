// Category → tRPC error-code mapping (docs/15 §4). The tRPC client reads
// data.{category,retryable,correlationId,code} off the error to drive UX.

import type { ForgeErrorCategory } from "./forge-error";

/** tRPC v11 error codes (docs/15 §4 table). */
export const TRPC_ERROR_CODES = [
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "TIMEOUT",
  "CONFLICT",
  "PRECONDITION_FAILED",
  "INTERNAL_SERVER_ERROR",
] as const;

export type TrpcErrorCode = (typeof TRPC_ERROR_CODES)[number];

/** The exhaustive category → tRPC code map (docs/15 §4). */
export const CATEGORY_TO_TRPC: Readonly<Record<ForgeErrorCategory, TrpcErrorCode>> = {
  auth: "UNAUTHORIZED",
  not_found: "NOT_FOUND",
  invalid_input: "BAD_REQUEST",
  budget_exhausted: "PRECONDITION_FAILED",
  transient: "TIMEOUT",
  upstream_failure: "INTERNAL_SERVER_ERROR",
  internal: "INTERNAL_SERVER_ERROR",
};

/** Look up the tRPC code for a category. */
export function trpcCodeFor(category: ForgeErrorCategory): TrpcErrorCode {
  return CATEGORY_TO_TRPC[category];
}

/** Every category maps — runtime assert used by the unit test (exhaustiveness). */
export function assertCategoryMapExhaustive(): void {
  for (const cat of [
    "auth",
    "not_found",
    "invalid_input",
    "budget_exhausted",
    "transient",
    "upstream_failure",
    "internal",
  ] as ForgeErrorCategory[]) {
    if (!(cat in CATEGORY_TO_TRPC)) {
      throw new Error(`CATEGORY_TO_TRPC missing mapping for category: ${cat}`);
    }
  }
}
