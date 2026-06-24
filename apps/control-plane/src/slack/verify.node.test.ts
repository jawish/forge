import { describe, expect, it } from "vitest";
import { computeSlackSignature, verifySlackRequest } from "./verify";

// Slack signing-secret verification (docs/19 Part A §4, checklist §8.1).
// Unit tests for the HMAC-SHA256 verify + replay protection.

const SECRET = "test-signing-secret-abc123";

describe("slack signing verification", () => {
  it("computeSlackSignature produces the v0= hex HMAC", async () => {
    const sig = await computeSlackSignature(SECRET, "1234567890", "hello=world");
    expect(sig).toMatch(/^v0=[0-9a-f]{64}$/);
  });

  it("verifySlackRequest accepts a correctly-signed request", async () => {
    const body = '{"type":"event_callback"}';
    const ts = "1234567890";
    const sig = await computeSlackSignature(SECRET, ts, body);
    const ok = await verifySlackRequest({
      signingSecret: SECRET,
      signature: sig,
      timestamp: ts,
      body,
      nowSeconds: 1234567890,
    });
    expect(ok).toBe(true);
  });

  it("verifySlackRequest rejects a bad signature", async () => {
    const ok = await verifySlackRequest({
      signingSecret: SECRET,
      signature: "v0=deadbeef",
      timestamp: "1234567890",
      body: "hello",
      nowSeconds: 1234567890,
    });
    expect(ok).toBe(false);
  });

  it("verifySlackRequest rejects a different signing secret", async () => {
    const body = "x";
    const ts = "1234567890";
    const sig = await computeSlackSignature("wrong-secret", ts, body);
    const ok = await verifySlackRequest({
      signingSecret: SECRET,
      signature: sig,
      timestamp: ts,
      body,
      nowSeconds: 1234567890,
    });
    expect(ok).toBe(false);
  });

  it("verifySlackRequest rejects stale timestamps (replay protection)", async () => {
    const body = "x";
    const ts = "1000000000"; // very old
    const sig = await computeSlackSignature(SECRET, ts, body);
    const ok = await verifySlackRequest({
      signingSecret: SECRET,
      signature: sig,
      timestamp: ts,
      body,
      nowSeconds: 1000000000 + 600, // 10 min later — past the 5-min window
    });
    expect(ok).toBe(false);
  });

  it("verifySlackRequest rejects missing headers", async () => {
    const ok = await verifySlackRequest({
      signingSecret: SECRET,
      signature: null,
      timestamp: "123",
      body: "x",
    });
    expect(ok).toBe(false);
  });
});
