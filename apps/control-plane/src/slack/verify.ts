// Slack signing-secret verification (docs/19 Part A §4, docs/08 §11).
// Slack signs every Events API request with HMAC-SHA256 using the app's signing
// secret. We verify before processing (reject forged/old requests). Uses the Web
// Crypto API (native to Workers — no node:crypto dependency).
//
// Signature format: header `X-Slack-Signature` = "v0=<hex hmac>".
// Signed string: "v0:<X-Slack-Request-Timestamp>:<raw body>".

/** Headers Slack sends on signed requests. */
export const SLACK_SIGNATURE_HEADER = "X-Slack-Signature";
export const SLACK_TIMESTAMP_HEADER = "X-Slack-Request-Timestamp";

/** Reject requests older than this (5 min — Slack's recommendation). */
const MAX_AGE_SECONDS = 60 * 5;

/** Hex-encode a byte array. */
function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compute the Slack signature for a body+timestamp using the signing secret.
 * Returns "v0=<hex>".
 */
export async function computeSlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
): Promise<string> {
  const baseString = `v0:${timestamp}:${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(baseString));
  return `v0=${toHex(sig)}`;
}

/** Timing-safe string comparison (constant time on equal-length strings). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a Slack request's signature. Returns true iff the signature matches AND
 * the timestamp is within MAX_AGE_SECONDS (rejects replayed old requests).
 */
export async function verifySlackRequest(opts: {
  signingSecret: string;
  signature: string | null;
  timestamp: string | null;
  body: string;
  nowSeconds?: number;
}): Promise<boolean> {
  const { signingSecret, signature, timestamp, body } = opts;
  if (!signature || !timestamp) return false;

  // Replay protection: reject stale timestamps.
  const nowSeconds = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > MAX_AGE_SECONDS) {
    return false;
  }

  const expected = await computeSlackSignature(signingSecret, timestamp, body);
  return timingSafeEqual(expected, signature);
}
