import { describe, expect, it } from "vitest";
import {
  auditObjectKey,
  computeChainHash,
  sealRecord,
  sha256Hex,
  verifyChain,
  type AuditRecord,
} from "./merkle";

// Audit Merkle chain (docs/12 §4, docs/08 §5, ADR-0005). Pure-crypto unit tests.

function baseRecord(i: number): Omit<AuditRecord, "thisHash" | "prevHash"> {
  return {
    eventId: `evt_${i}`,
    sessionId: "sess_1",
    ts: 1_700_000_000_000 + i,
    actorId: "user_1",
    actorType: "user",
    action: "status_transition",
    target: { type: "session", id: "sess_1" },
    beforeJson: null,
    afterJson: `{"status":"active"}`,
    correlationId: `trace_${i}`,
  };
}

describe("sha256Hex", () => {
  it("produces a 64-char hex SHA-256", async () => {
    const h = await sha256Hex("hello");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic + matches the known SHA-256 of "hello".
    expect(h).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});

describe("sealRecord + computeChainHash", () => {
  it("seals a genesis record (prevHash null) with a chain hash", async () => {
    const sealed = await sealRecord(baseRecord(0), null);
    expect(sealed.prevHash).toBeNull();
    expect(sealed.thisHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the chain hash depends on prevHash (binding to the previous event)", async () => {
    const r = baseRecord(1);
    const h1 = await computeChainHash({ ...r, prevHash: null });
    const h2 = await computeChainHash({ ...r, prevHash: "abc" });
    expect(h1).not.toBe(h2);
  });

  it("the chain hash is deterministic for identical input", async () => {
    const r = baseRecord(1);
    const a = await computeChainHash({ ...r, prevHash: "x" });
    const b = await computeChainHash({ ...r, prevHash: "x" });
    expect(a).toBe(b);
  });
});

describe("verifyChain", () => {
  it("verifies an intact chain", async () => {
    const records: AuditRecord[] = [];
    let prev: string | null = null;
    for (let i = 0; i < 5; i++) {
      const sealed = await sealRecord(baseRecord(i), prev);
      records.push(sealed);
      prev = sealed.thisHash;
    }
    const result = await verifyChain(records);
    expect(result.ok).toBe(true);
  });

  it("detects a tampered record (hash mismatch)", async () => {
    const records: AuditRecord[] = [];
    let prev: string | null = null;
    for (let i = 0; i < 3; i++) {
      const sealed = await sealRecord(baseRecord(i), prev);
      records.push(sealed);
      prev = sealed.thisHash;
    }
    // Tamper: change the afterJson of record 1 without recomputing its hash.
    records[1]! = { ...records[1]!, afterJson: '{"status":"cancelled"}' };
    const result = await verifyChain(records);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.atIndex).toBe(1);
      expect(result.reason).toContain("tampered");
    }
  });

  it("detects a broken chain link (reordered/missing event)", async () => {
    const records: AuditRecord[] = [];
    let prev: string | null = null;
    for (let i = 0; i < 3; i++) {
      const sealed = await sealRecord(baseRecord(i), prev);
      records.push(sealed);
      prev = sealed.thisHash;
    }
    // Break: replace record 2's prevHash with a wrong value.
    records[2]! = { ...records[2]!, prevHash: "wrong" };
    const result = await verifyChain(records);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("link");
  });

  it("verifies an empty chain", async () => {
    expect((await verifyChain([])).ok).toBe(true);
  });
});

describe("auditObjectKey — date-partitioned R2 key (docs/12 §4)", () => {
  it("partitions by yyyy/mm/dd/hh", () => {
    const key = auditObjectKey({ eventId: "evt_1", ts: Date.UTC(2026, 5, 24, 13, 5) });
    expect(key).toBe("audit/2026/06/24/13/evt_1.json");
  });
});
