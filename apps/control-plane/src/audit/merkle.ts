// Audit trail — R2 Object Lock + Merkle chain (docs/08 §5, docs/12 §4, ADR-0005).
// Each audit event includes the hash of the previous event (Merkle chain link),
// making the trail tamper-evident. The Merkle root is anchored hourly to Rekor
// (Sigstore transparency log) — that's the §8.4/prod wiring; the chain itself is
// pure crypto (Web Crypto SHA-256), fully testable.
//
// Storage: R2 Object Lock Compliance mode (WORM — even root can't delete within
// retention). One JSONL object per event, date-partitioned (docs/12 §4).

/** The canonical event shape written to R2 audit (docs/12 §4). */
export interface AuditRecord {
  eventId: string;
  sessionId: string;
  ts: number;
  actorId: string;
  actorType: "user" | "system" | "agent";
  action:
    | "prompt"
    | "tool_call"
    | "edit"
    | "commit"
    | "pr_create"
    | "policy_change"
    | "status_transition";
  target: { type: "file" | "repo" | "pr" | "mcp" | "session"; id: string };
  beforeJson: string | null;
  afterJson: string | null;
  correlationId: string;
  prevHash: string | null; // Merkle chain link
  thisHash: string; // sha256(canonical_json || prevHash)
}

/** Hex-encode a byte array. */
function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 a string → hex (Web Crypto — native to Workers). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return toHex(digest);
}

/** The canonical JSON for hashing (stable key order — docs/12 §4). */
function canonicalJson(record: Omit<AuditRecord, "thisHash">): string {
  return JSON.stringify({
    eventId: record.eventId,
    sessionId: record.sessionId,
    ts: record.ts,
    actorId: record.actorId,
    actorType: record.actorType,
    action: record.action,
    target: record.target,
    beforeJson: record.beforeJson,
    afterJson: record.afterJson,
    correlationId: record.correlationId,
    prevHash: record.prevHash,
  });
}

/**
 * Compute the chain hash for a record: sha256(canonical_json(this_record) || prevHash).
 * The prevHash binds this event to the previous one (Merkle chain — docs/12 §4).
 */
export async function computeChainHash(record: Omit<AuditRecord, "thisHash">): Promise<string> {
  return sha256Hex(`${canonicalJson(record)}|${record.prevHash ?? ""}`);
}

/**
 * Seal an audit record into the chain: attach the prevHash + compute thisHash.
 * Callers provide prevHash (the last event's thisHash, or null for the genesis).
 */
export async function sealRecord(
  record: Omit<AuditRecord, "thisHash" | "prevHash">,
  prevHash: string | null,
): Promise<AuditRecord> {
  const withPrev = { ...record, prevHash };
  const thisHash = await computeChainHash(withPrev);
  return { ...withPrev, thisHash };
}

/**
 * Verify a chain: recompute each event's hash from its canonical form + prevHash,
 * and assert the chain links are unbroken (docs/12 §4). Returns the first break
 * or null if the whole chain is intact.
 */
export async function verifyChain(
  records: ReadonlyArray<AuditRecord>,
): Promise<{ ok: true } | { ok: false; atIndex: number; reason: string }> {
  let prevHash: string | null = null;
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    // Link check: the record's prevHash must equal the previous record's thisHash.
    if (r.prevHash !== prevHash) {
      return { ok: false, atIndex: i, reason: `broken chain link at ${i}: prevHash mismatch` };
    }
    // Hash check: recompute and compare.
    const expected = await computeChainHash({
      eventId: r.eventId,
      sessionId: r.sessionId,
      ts: r.ts,
      actorId: r.actorId,
      actorType: r.actorType,
      action: r.action,
      target: r.target,
      beforeJson: r.beforeJson,
      afterJson: r.afterJson,
      correlationId: r.correlationId,
      prevHash: r.prevHash,
    });
    if (expected !== r.thisHash) {
      return { ok: false, atIndex: i, reason: `hash mismatch at ${i}: record tampered` };
    }
    prevHash = r.thisHash;
  }
  return { ok: true };
}

/** The R2 object key for an audit event (date-partitioned — docs/12 §4). */
export function auditObjectKey(record: { eventId: string; ts: number }): string {
  const d = new Date(record.ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `audit/${yyyy}/${mm}/${dd}/${hh}/${record.eventId}.json`;
}
