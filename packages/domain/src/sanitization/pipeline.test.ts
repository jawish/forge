import { describe, expect, it } from "vitest";
import { redactContent, sanitizeEvent, type RawSessionEvent } from "./pipeline";

// Sanitization pipeline (docs/18 Part A). Unit tests:
// - layered redaction (structured patterns + contextual heuristics) on the corpus
// - projection-first: raw content never appears in the sanitized payload
// - fail-closed: unclassifiable values → SANITIZATION_FAILED

describe("redactContent — structured patterns (docs/18 §3)", () => {
  it("redacts AWS access keys", () => {
    expect(redactContent("key=AKIAIOSFODNN7EXAMPLE")).toBe("key=[REDACTED:aws_key]");
  });
  it("redacts GitHub tokens", () => {
    const t = "ghp_" + "a".repeat(36);
    expect(redactContent(`token=${t}`)).toBe("token=[REDACTED:github_token]");
  });
  it("redacts JWTs", () => {
    const jwt = `eyJhbGciOi.${"b".repeat(20)}.${"c".repeat(20)}`;
    expect(redactContent(`auth=${jwt}`)).toBe("auth=[REDACTED:jwt]");
  });
  it("redacts PEM private-key blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----";
    expect(redactContent(pem)).toBe("[REDACTED:pem]");
  });
});

describe("redactContent — contextual heuristics (docs/18 §3)", () => {
  it("redacts NAME=VALUE for sensitive names", () => {
    expect(redactContent("API_KEY=sk_live_1234567890")).toBe("API_KEY=[REDACTED]");
    expect(redactContent('DB_PASSWORD="hunter2"')).toBe("DB_PASSWORD=[REDACTED]");
  });
  it("does not redact non-sensitive values", () => {
    expect(redactContent("the count is 42")).toBe("the count is 42");
    expect(redactContent("npm install --save-dev vitest")).toBe("npm install --save-dev vitest");
  });
});

describe("sanitizeEvent — projection-first (docs/18 §1, §2)", () => {
  const base: RawSessionEvent = {
    eventType: "prompt",
    sessionId: "sess_1",
    repoId: "repo_1",
    userId: "user_1",
    ts: 1700000000000,
    status: "active",
    activity: "running",
    actorId: "user_1",
  };

  it("includes only structurally-safe fields (no raw content by construction)", () => {
    const result = sanitizeEvent({
      ...base,
      rawContent: {
        promptText: "fix the bug with password=hunter2", // NEVER in payload
        toolArgsJson: '{"path":"secrets/key.pem"}', // NEVER in payload
        toolResultJson: "AWS_KEY=AKIAEXAMPLE", // NEVER in payload
      },
    });
    expect(result.failed).toBe(false);
    const payload = JSON.parse(result.event!.payload);
    // Raw prompt text / tool args / tool results are NOT in the projection.
    expect(JSON.stringify(payload)).not.toContain("fix the bug");
    expect(JSON.stringify(payload)).not.toContain("toolArgs");
    expect(JSON.stringify(payload)).not.toContain("secrets/key.pem");
    // Safe structural fields ARE present.
    expect(payload.event_type).toBe("prompt");
    expect(result.event!.repoId).toBe("repo_1");
    expect(result.event!.eventType).toBe("prompt");
  });

  it("includes cost + token fields (safe by construction)", () => {
    const result = sanitizeEvent({
      ...base,
      eventType: "cost_event",
      costUsd: 0.042,
      tokensIn: 1200,
      tokensOut: 800,
      model: "claude-sonnet-4-6",
    });
    expect(result.event!.costUsd).toBe(0.042);
    expect(result.event!.tokensIn).toBe(1200);
    expect(result.event!.model).toBe("claude-sonnet-4-6");
  });

  it("redacts the error_message_truncated content field (the one included field)", () => {
    const result = sanitizeEvent({
      ...base,
      eventType: "error",
      rawContent: { errorMessage: "failed: API_KEY=sk_live_secret" },
    });
    const payload = JSON.parse(result.event!.payload);
    expect(payload.error_message_truncated).toBe("failed: API_KEY=[REDACTED]");
    expect(result.failed).toBe(false); // was classifiable (redaction applied)
  });
});

describe("sanitizeEvent — fail-closed (docs/18 §3, docs/15 §3)", () => {
  it("flags SANITIZATION_FAILED on an unclassifiable high-entropy blob", () => {
    const result = sanitizeEvent({
      eventType: "error",
      sessionId: "s",
      repoId: "r",
      userId: "u",
      ts: 1,
      status: "failed",
      activity: null,
      actorId: "u",
      rawContent: { errorMessage: "x".repeat(60) }, // bare high-entropy blob, no spaces
    });
    expect(result.failed).toBe(true);
    expect(result.reason).toContain("unclassifiable");
    const payload = JSON.parse(result.event!.payload);
    expect(payload.error_message_truncated).toBe("[REDACTED:unclassifiable]");
  });
});
