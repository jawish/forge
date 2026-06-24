import { describe, expect, it } from "vitest";
import {
  buildPathScope,
  checkAccess,
  GlobMatcher,
  validateEdit,
  validateEdits,
} from "./path-scope";

// Path scoping + safe edit (docs/18 §2, docs/13 §2, checklist §8.2).
// Pure-logic unit tests for the glob matcher, access decisions, and edit validation.

const SCOPE = buildPathScope({
  sensitive: ["secrets/**", ".env*", "*.pem", "*.key"],
  readonly: ["docs/policies/**"],
});

describe("GlobMatcher", () => {
  it("matches ** globs (any depth)", () => {
    const m = new GlobMatcher(["secrets/**"]);
    expect(m.matches("secrets/api.json")).toBe(true);
    expect(m.matches("secrets/sub/deep.json")).toBe(true);
    expect(m.matches("notsecrets/x")).toBe(false);
  });
  it("matches * globs (single segment)", () => {
    const m = new GlobMatcher(["*.pem"]);
    expect(m.matches("cert.pem")).toBe(true);
    expect(m.matches("path/cert.pem")).toBe(false);
  });
  it("matches prefix-dot globs (.env*)", () => {
    const m = new GlobMatcher([".env*"]);
    expect(m.matches(".env")).toBe(true);
    expect(m.matches(".env.local")).toBe(true);
    expect(m.matches("config.env")).toBe(false);
  });
});

describe("checkAccess (docs/18 §2)", () => {
  it("denies read AND write on sensitive paths", () => {
    expect(checkAccess(SCOPE, "secrets/api.json", "read")).toBe("deny_sensitive");
    expect(checkAccess(SCOPE, "secrets/api.json", "write")).toBe("deny_sensitive");
    expect(checkAccess(SCOPE, ".env", "read")).toBe("deny_sensitive");
    expect(checkAccess(SCOPE, "id_rsa.pem", "write")).toBe("deny_sensitive");
  });
  it("allows read but denies write on readonly paths", () => {
    expect(checkAccess(SCOPE, "docs/policies/handbook.md", "read")).toBe("allow");
    expect(checkAccess(SCOPE, "docs/policies/handbook.md", "write")).toBe("deny_readonly_write");
  });
  it("allows read + write on ordinary paths", () => {
    expect(checkAccess(SCOPE, "src/index.ts", "read")).toBe("allow");
    expect(checkAccess(SCOPE, "src/index.ts", "write")).toBe("allow");
  });
});

describe("validateEdit — safe edit (docs/01, checklist §8.2)", () => {
  it("allows an edit to an ordinary writable path", () => {
    expect(
      validateEdit(SCOPE, { path: "src/index.ts", newContent: "export const x = 1;" }),
    ).toEqual({
      allowed: true,
    });
  });
  it("denies an edit to a sensitive path (never edit secrets)", () => {
    const v = validateEdit(SCOPE, { path: "secrets/api.json", newContent: "{}" });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("sensitive");
  });
  it("denies an edit to a readonly path", () => {
    const v = validateEdit(SCOPE, { path: "docs/policies/handbook.md", newContent: "x" });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("readonly");
  });
  it("denies a delete (not a safe edit without confirmation)", () => {
    const v = validateEdit(SCOPE, { path: "src/index.ts", newContent: null });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("delete");
  });
});

describe("validateEdits — batch", () => {
  it("returns all failures (sensitive + readonly)", () => {
    const r = validateEdits(SCOPE, [
      { path: "src/a.ts", newContent: "a" },
      { path: "secrets/k.json", newContent: "x" },
      { path: "docs/policies/p.md", newContent: "y" },
    ]);
    expect(r.allowed).toBe(false);
    expect(r.failures).toHaveLength(2);
    expect(r.failures[0]!.edit.path).toBe("secrets/k.json");
  });
  it("allows a clean batch", () => {
    const r = validateEdits(SCOPE, [
      { path: "src/a.ts", newContent: "a" },
      { path: "src/b.ts", newContent: "b" },
    ]);
    expect(r.allowed).toBe(true);
    expect(r.failures).toEqual([]);
  });
});
