// CF Access JWT verification (docs/08 §10, §7.4 auth spike, docs/10 §2).
// The web front door is behind Cloudflare Access (Zero Trust) federating to Google
// Workspace. Access sets the `cf-access-jwt-assertion` header on every authed
// request; we verify its signature against CF's public keys + extract the identity.
//
// Pure crypto logic (Web Crypto); the JWKS fetch is an injected port (testable).
// In fast, the context stub (§5.7) returns a dev user without real verification;
// this module is the real verification used in real/staging/prod.

/** The CF Access JWT payload shape (docs/08 §10). */
export interface CfAccessPayload {
  sub: string; // stable user id
  email: string;
  name?: string;
  groups?: string[];
  iss: string; // https://<team>.cloudflareaccess.com
  aud: string[]; // the AUD claim (the Access app id)
  exp: number; // expiry (unix seconds)
  iat: number;
}

/** A decoded CF Access JWT (header + payload + signature). */
export interface DecodedJwt {
  header: { kid: string; alg: string; typ: string };
  payload: CfAccessPayload;
  signature: Uint8Array;
  raw: { header: string; payload: string; signature: string };
}

/** Decode (NOT verify) a JWT into its parts. Verification is separate. */
export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed JWT (expected 3 parts)");
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  const header = JSON.parse(atob(headerB64)) as DecodedJwt["header"];
  const payload = JSON.parse(atob(payloadB64)) as CfAccessPayload;
  const signature = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
  return {
    header,
    payload,
    signature,
    raw: { header: headerB64, payload: payloadB64, signature: signatureB64 },
  };
}

/** Port: fetch the CF Access JWKS (public keys) for the team domain. */
export type FetchJwks = (
  teamDomain: string,
) => Promise<{ keys: Array<{ kid: string; key: CryptoKey }> }>;

/**
 * Verify a CF Access JWT (docs/08 §10, §7.4). Checks:
 *   1. Signature against the CF Access public keys (RS256).
 *   2. Expiry (not expired).
 *   3. Issuer matches the team domain.
 *   4. Audience matches the app id.
 *
 * Returns the verified payload or throws.
 */
export async function verifyCfAccessJwt(opts: {
  token: string;
  teamDomain: string; // e.g. myteam.cloudflareaccess.com
  appId: string; // the Access app AUD
  fetchJwks: FetchJwks;
  nowSeconds?: number;
}): Promise<CfAccessPayload> {
  const decoded = decodeJwt(opts.token);
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);

  // 1. Expiry.
  if (decoded.payload.exp <= now) {
    throw new Error(`CF Access JWT expired (exp ${decoded.payload.exp}, now ${now})`);
  }

  // 2. Issuer.
  const expectedIss = `https://${opts.teamDomain}`;
  if (decoded.payload.iss !== expectedIss) {
    throw new Error(`CF Access JWT issuer mismatch: ${decoded.payload.iss} ≠ ${expectedIss}`);
  }

  // 3. Audience.
  if (!decoded.payload.aud.includes(opts.appId)) {
    throw new Error(
      `CF Access JWT audience mismatch: ${opts.appId} not in [${decoded.payload.aud.join(", ")}]`,
    );
  }

  // 4. Signature: fetch the JWKS, find the key by kid, verify with RS256.
  const jwks = await opts.fetchJwks(opts.teamDomain);
  const key = jwks.keys.find((k) => k.kid === decoded.header.kid);
  if (!key) {
    throw new Error(`CF Access JWT key not found: kid ${decoded.header.kid}`);
  }
  const signedData = new TextEncoder().encode(`${decoded.raw.header}.${decoded.raw.payload}`);
  const valid = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    key.key,
    decoded.signature,
    signedData,
  );
  if (!valid) {
    throw new Error("CF Access JWT signature invalid");
  }

  return decoded.payload;
}

/** Extract the user id (sub) for the forge.user.id attribute (docs/10 §2). */
export function userIdFromPayload(payload: CfAccessPayload): string {
  return payload.sub;
}
