// Forge error contract — 7 decision-type categories (docs/15 §1–§2), organic
// domain codes, and the ForgeError class with a correlationId. Categories are
// stable (they're decision-types); codes grow organically as failures get names.
// Never pre-design the taxonomy.

/** The 7 error categories. Consumers make decisions based on ~7 categories. */
export const ERROR_CATEGORIES = [
  "auth", // token expired, not allowed
  "not_found", // session/repo/config doesn't exist
  "invalid_input", // bad prompt, invalid config, illegal transition
  "budget_exhausted", // cost limit hit
  "transient", // provider timeout, sandbox capacity, rate limit
  "upstream_failure", // AI Gateway 5xx after retries, GitHub down
  "internal", // unexpected exception, bug
] as const;

export type ForgeErrorCategory = (typeof ERROR_CATEGORIES)[number];

/**
 * Initial seed of domain codes (docs/15 §3). This list is NOT exhaustive — add
 * codes as real failure patterns emerge and get names. Each code maps to a category.
 */
export const ERROR_CODES = {
  BUDGET_EXHAUSTED: "budget_exhausted" as const,
  ILLEGAL_TRANSITION: "invalid_input" as const,
  SANDBOX_PROVISIONING_FAILED: "transient" as const, // transient/upstream — context-dependent
  STUCK_TIMEOUT: "internal" as const,
  SANITIZATION_FAILED: "internal" as const,
  PROVIDER_ERROR: "upstream_failure" as const,
  CONFIG_VALIDATION_FAILED: "invalid_input" as const,
  GIT_IDENTITY_ERROR: "auth" as const,
} as const;

export type ForgeErrorCode = keyof typeof ERROR_CODES;

/** Whether a category is retryable (docs/15 §2). */
export function isRetryableCategory(category: ForgeErrorCategory): boolean {
  if (category === "transient") return true;
  if (category === "upstream_failure") return true; // "maybe" — one retry then surface
  return false;
}

/** The error contract every error crossing a seam carries (docs/15 §1). */
export interface ForgeErrorData {
  category: ForgeErrorCategory;
  retryable: boolean; // derived from category but explicit per-context
  message: string; // human-readable, safe to show users (no secrets)
  correlationId: string; // OTel trace id — always present
  code?: string; // optional domain-specific code for grep (grows organically)
  details?: unknown; // typed per-code, optional (budget details, transition attempted, ...)
  cause?: unknown;
}

/**
 * The Forge error class. Always carries a correlationId. Subclasses are NOT the
 * taxonomy — the `category` + `code` fields are. This keeps the model flat and
 * grep-friendly (docs/15 §1 rationale).
 */
export class ForgeError extends Error implements ForgeErrorData {
  readonly category: ForgeErrorCategory;
  readonly retryable: boolean;
  readonly correlationId: string;
  readonly code?: string;
  readonly details?: unknown;

  constructor(input: Omit<ForgeErrorData, "retryable"> & { retryable?: boolean }) {
    super(input.message);
    this.name = "ForgeError";
    this.category = input.category;
    this.correlationId = input.correlationId;
    this.code = input.code;
    this.details = input.details;
    // retryable defaults from category unless explicitly overridden per-context.
    this.retryable = input.retryable ?? isRetryableCategory(input.category);
    if (input.cause !== undefined) {
      (this as { cause?: unknown }).cause = input.cause;
    }
  }

  /** Serialize to the agent-safe shape (no stack, no secrets) — for MCP tools (15 §4). */
  toAgentSafe(): { category: ForgeErrorCategory; retryable: boolean; message: string } {
    return { category: this.category, retryable: this.retryable, message: this.message };
  }

  /** Serialize to the user-facing shape (message + correlationId) — for Slack/web (15 §4). */
  toUserFacing(): { message: string; correlationId: string; code?: string } {
    return { message: this.message, correlationId: this.correlationId, code: this.code };
  }
}

/** Thrown on illegal state-machine transitions (docs/11 §4, §3.7). */
export class IllegalTransitionError extends ForgeError {
  constructor(from: string, to: string, correlationId: string, details?: unknown) {
    super({
      category: "invalid_input",
      code: "ILLEGAL_TRANSITION",
      message: `Illegal session transition: ${from} → ${to}`,
      correlationId,
      details: { from, to, ...(details as object) },
    });
    this.name = "IllegalTransitionError";
  }
}
