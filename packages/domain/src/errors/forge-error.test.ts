import { describe, expect, it } from "vitest";
import {
  assertCategoryMapExhaustive,
  CATEGORY_TO_TRPC,
  ERROR_CATEGORIES,
  ERROR_CODES,
  ForgeError,
  IllegalTransitionError,
  isRetryableCategory,
  trpcCodeFor,
} from "../index";
import type { ForgeErrorCategory, TrpcErrorCode } from "../index";

describe("error model — 7 categories (docs/15 §2)", () => {
  it("has exactly 7 categories", () => {
    expect(ERROR_CATEGORIES).toHaveLength(7);
    expect(ERROR_CATEGORIES).toEqual(
      expect.arrayContaining([
        "auth",
        "not_found",
        "invalid_input",
        "budget_exhausted",
        "transient",
        "upstream_failure",
        "internal",
      ]),
    );
  });

  it("retryability derives from category: only transient + upstream are retryable", () => {
    const retryable: ForgeErrorCategory[] = [];
    for (const c of ERROR_CATEGORIES) if (isRetryableCategory(c)) retryable.push(c);
    expect(retryable.sort()).toEqual(["transient", "upstream_failure"]);
  });
});

describe("error model — ForgeError contract (docs/15 §1)", () => {
  it("always carries a correlationId", () => {
    const e = new ForgeError({ category: "internal", message: "boom", correlationId: "trace_1" });
    expect(e.correlationId).toBe("trace_1");
    expect(e.message).toBe("boom");
    expect(e.category).toBe("internal");
    expect(e.retryable).toBe(false); // internal is not retryable
  });

  it("retryable defaults from category, overridable per-context", () => {
    const transient = new ForgeError({
      category: "transient",
      message: "timeout",
      correlationId: "t2",
    });
    expect(transient.retryable).toBe(true); // transient defaults retryable

    const forcedNonRetryable = new ForgeError({
      category: "transient",
      message: "rate-limited, do not retry",
      correlationId: "t3",
      retryable: false,
    });
    expect(forcedNonRetryable.retryable).toBe(false);
  });

  it("carries an optional domain code + details", () => {
    const e = new ForgeError({
      category: "budget_exhausted",
      code: "BUDGET_EXHAUSTED",
      message: "session over budget",
      correlationId: "t4",
      details: { spentUsd: 12.5, limitUsd: 10 },
    });
    expect(e.code).toBe("BUDGET_EXHAUSTED");
    expect(e.details).toEqual({ spentUsd: 12.5, limitUsd: 10 });
  });

  it("toAgentSafe strips internals (no stack, no secrets)", () => {
    const e = new ForgeError({ category: "auth", message: "no", correlationId: "secret-trace" });
    const safe = e.toAgentSafe();
    expect(safe).toEqual({ category: "auth", retryable: false, message: "no" });
    expect(safe).not.toHaveProperty("correlationId");
  });

  it("toUserFacing includes correlationId + code only", () => {
    const e = new ForgeError({
      category: "internal",
      code: "STUCK_TIMEOUT",
      message: "agent stuck",
      correlationId: "trace_xyz",
    });
    expect(e.toUserFacing()).toEqual({
      message: "agent stuck",
      correlationId: "trace_xyz",
      code: "STUCK_TIMEOUT",
    });
  });
});

describe("error model — IllegalTransitionError (docs/11 §7)", () => {
  it("is an invalid_input / ILLEGAL_TRANSITION with from+to details", () => {
    const e = new IllegalTransitionError("active", "queued", "trace_5");
    expect(e).toBeInstanceOf(ForgeError);
    expect(e.category).toBe("invalid_input");
    expect(e.code).toBe("ILLEGAL_TRANSITION");
    expect(e.retryable).toBe(false);
    expect(e.details).toMatchObject({ from: "active", to: "queued" });
    expect(e.message).toContain("active → queued");
  });
});

describe("error model — seeded domain codes (docs/15 §3)", () => {
  it("includes all 8 seeded codes mapped to their categories", () => {
    expect(ERROR_CODES).toMatchObject({
      BUDGET_EXHAUSTED: "budget_exhausted",
      ILLEGAL_TRANSITION: "invalid_input",
      SANDBOX_PROVISIONING_FAILED: "transient",
      STUCK_TIMEOUT: "internal",
      SANITIZATION_FAILED: "internal",
      PROVIDER_ERROR: "upstream_failure",
      CONFIG_VALIDATION_FAILED: "invalid_input",
      GIT_IDENTITY_ERROR: "auth",
    });
  });
});

describe("error model — category → tRPC map (docs/15 §4)", () => {
  it("maps every category to a tRPC code exactly per the spec table", () => {
    expect(CATEGORY_TO_TRPC).toEqual({
      auth: "UNAUTHORIZED",
      not_found: "NOT_FOUND",
      invalid_input: "BAD_REQUEST",
      budget_exhausted: "PRECONDITION_FAILED",
      transient: "TIMEOUT",
      upstream_failure: "INTERNAL_SERVER_ERROR",
      internal: "INTERNAL_SERVER_ERROR",
    });
  });

  it("trpcCodeFor returns the right code per category", () => {
    expect(trpcCodeFor("auth")).toBe("UNAUTHORIZED");
    expect(trpcCodeFor("budget_exhausted")).toBe("PRECONDITION_FAILED");
    expect(trpcCodeFor("transient")).toBe("TIMEOUT");
  });

  it("the map is exhaustive (every category present)", () => {
    expect(() => assertCategoryMapExhaustive()).not.toThrow();
  });

  it("every mapped value is a valid tRPC error code", () => {
    const validCodes: TrpcErrorCode[] = [
      "BAD_REQUEST",
      "UNAUTHORIZED",
      "FORBIDDEN",
      "NOT_FOUND",
      "TIMEOUT",
      "CONFLICT",
      "PRECONDITION_FAILED",
      "INTERNAL_SERVER_ERROR",
    ];
    for (const code of Object.values(CATEGORY_TO_TRPC)) {
      expect(validCodes).toContain(code);
    }
  });
});
