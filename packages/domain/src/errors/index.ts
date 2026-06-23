// @forge/domain errors barrel — the contract-first error model (docs/15).

export {
  ERROR_CATEGORIES,
  ERROR_CODES,
  ForgeError,
  IllegalTransitionError,
  isRetryableCategory,
} from "./forge-error";
export type { ForgeErrorCategory, ForgeErrorCode, ForgeErrorData } from "./forge-error";
export {
  TRPC_ERROR_CODES,
  CATEGORY_TO_TRPC,
  trpcCodeFor,
  assertCategoryMapExhaustive,
} from "./trpc-map";
export type { TrpcErrorCode } from "./trpc-map";
