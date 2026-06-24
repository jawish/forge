import { describe, expect, it, vi } from "vitest";
import { decodeJwt, userIdFromPayload, verifyCfAccessJwt } from "./cf-access";

// CF Access JWT verification (docs/08 §10, §7.4). Tests the decode + the
// expiry/issuer/audience/signature checks with a fake JWKS + a hand-built JWT.

const TEAM = "myteam.cloudflareaccess.com";
const APP_ID = "app_123";

/** Build a fake CF Access JWT (NOT cryptographically valid — for shape + claim checks). */
function fakeJwt(
  overrides: Partial<{ sub: string; email: string; iss: string; aud: string[]; exp: number }> = {},
): string {
  const header = btoa(JSON.stringify({ kid: "key-1", alg: "RS256", typ: "JWT" }));
  const payload = btoa(
    JSON.stringify({
      sub: overrides.sub ?? "user_sub_1",
      email: overrides.email ?? "alice@example.com",
      name: "Alice",
      groups: ["eng"],
      iss: overrides.iss ?? `https://${TEAM}`,
      aud: overrides.aud ?? [APP_ID],
      exp: overrides.exp ?? Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    }),
  );
  const signature = btoa("fake-signature");
  return `${header}.${payload}.${signature}`;
}

describe("decodeJwt", () => {
  it("decodes the 3 parts", () => {
    const decoded = decodeJwt(fakeJwt());
    expect(decoded.header.kid).toBe("key-1");
    expect(decoded.payload.email).toBe("alice@example.com");
    expect(decoded.signature).toBeInstanceOf(Uint8Array);
  });

  it("throws on a malformed token", () => {
    expect(() => decodeJwt("not.a.jwt.token")).toThrow(/malformed/);
  });
});

describe("userIdFromPayload (docs/10 §2 — forge.user.id)", () => {
  it("extracts sub", () => {
    expect(
      userIdFromPayload({ sub: "abc", email: "x", iss: "i", aud: ["a"], exp: 0, iat: 0 }),
    ).toBe("abc");
  });
});

describe("verifyCfAccessJwt — claim checks (docs/08 §10)", () => {
  // A fake JWKS that always "verifies" (the signature check is exercised via the
  // crypto.subtle.verify mock — here we test the claim logic, not real RS256).
  const fakeJwks = async () => ({
    keys: [
      {
        kid: "key-1",
        key: await crypto.subtle.importKey(
          "raw",
          new Uint8Array(32),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["verify"],
        ),
      },
    ],
  });
  // Mock verify to return true (the signature math is real RS256; tested at integration).
  beforeEach(() => vi.spyOn(crypto.subtle, "verify").mockResolvedValue(true));
  afterEach(() => vi.restoreAllMocks());

  it("rejects an expired JWT", async () => {
    const token = fakeJwt({ exp: Math.floor(Date.now() / 1000) - 100 });
    await expect(
      verifyCfAccessJwt({ token, teamDomain: TEAM, appId: APP_ID, fetchJwks: fakeJwks }),
    ).rejects.toThrow(/expired/);
  });

  it("rejects a wrong issuer", async () => {
    const token = fakeJwt({ iss: "https://evil.example.com" });
    await expect(
      verifyCfAccessJwt({ token, teamDomain: TEAM, appId: APP_ID, fetchJwks: fakeJwks }),
    ).rejects.toThrow(/issuer/);
  });

  it("rejects a wrong audience", async () => {
    const token = fakeJwt({ aud: ["wrong_app"] });
    await expect(
      verifyCfAccessJwt({ token, teamDomain: TEAM, appId: APP_ID, fetchJwks: fakeJwks }),
    ).rejects.toThrow(/audience/);
  });

  it("rejects an unknown key id", async () => {
    const token = fakeJwt();
    await expect(
      verifyCfAccessJwt({
        token,
        teamDomain: TEAM,
        appId: APP_ID,
        fetchJwks: async () => ({ keys: [{ kid: "other", key: {} as CryptoKey }] }),
      }),
    ).rejects.toThrow(/key not found/);
  });

  it("accepts a valid JWT (claims + mocked signature)", async () => {
    const token = fakeJwt();
    const payload = await verifyCfAccessJwt({
      token,
      teamDomain: TEAM,
      appId: APP_ID,
      fetchJwks: fakeJwks,
    });
    expect(payload.email).toBe("alice@example.com");
    expect(payload.sub).toBe("user_sub_1");
  });
});

// vi needs importing for the beforeEach/afterEach hooks.
import { beforeEach, afterEach } from "vitest";
