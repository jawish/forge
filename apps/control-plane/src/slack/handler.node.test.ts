import { describe, expect, it } from "vitest";
import { handleSlackEvent } from "./handler";
import { computeSlackSignature } from "./verify";
import type { IntentFilter, RepoRouter } from "./classifier";
import type { SlackPorts } from "./handler";

// Slack handler end-to-end (docs/19 Part A, checklist §8.1). Drives verify →
// parse → extract trigger → classify → act with injected fake ports. Covers
// url_verification, reject, auto-spawn, dedup, confirm, disambiguate, explain.

const SECRET = "slack-signing-secret-test";

/** Build fake ports recording posted messages + spawns. */
function fakePorts(opts: {
  intent: IntentFilter;
  router: RepoRouter;
  existing?: Record<string, string>;
}): { ports: SlackPorts; posts: string[]; spawns: string[] } {
  const posts: string[] = [];
  const spawns: string[] = [];
  const ports: SlackPorts = {
    intentFilter: opts.intent,
    repoRouter: opts.router,
    async postToThread(_ch, _ts, text) {
      posts.push(text);
      return "posted-ts";
    },
    async getExistingSession(key) {
      return opts.existing?.[key] ?? null;
    },
    async spawnSession(repoId) {
      const id = `sess_${repoId}_${spawns.length}`;
      spawns.push(id);
      return id;
    },
    async defaultBranchFor() {
      return "main";
    },
  };
  return { ports, posts, spawns };
}

/** Build a signed app_mention envelope + headers. */
async function signedMention(text: string, now = 1_700_000_000) {
  const body = JSON.stringify({
    token: "t",
    team_id: "T",
    api_app_id: "A",
    type: "event_callback",
    event_id: "eid",
    event_ts: String(now),
    event: {
      type: "app_mention",
      user: "U1",
      text,
      ts: String(now),
      channel: "C1",
    },
  });
  return {
    rawBody: body,
    signature: await computeSlackSignature(SECRET, String(now), body),
    timestamp: String(now),
    nowSeconds: now,
  };
}

describe("slack handler — url_verification handshake", () => {
  it("echoes back the challenge (one-time setup)", async () => {
    const body = JSON.stringify({ token: "t", challenge: "abc123", type: "url_verification" });
    const sig = await computeSlackSignature(SECRET, "100", body);
    const { ports } = fakePorts({
      intent: async () => ({ isCodingTask: true, confidence: 0.9 }),
      router: async () => [],
    });
    const result = await handleSlackEvent({
      config: { signingSecret: SECRET },
      ports,
      signature: sig,
      timestamp: "100",
      rawBody: body,
      nowSeconds: 100,
    });

    expect(result).toEqual({ kind: "url_verification", challenge: "abc123" });
  });
});

describe("slack handler — security", () => {
  it("throws on a bad signature (auth error)", async () => {
    const { ports } = fakePorts({
      intent: async () => ({ isCodingTask: true, confidence: 0.9 }),
      router: async () => [],
    });
    await expect(
      handleSlackEvent({
        config: { signingSecret: SECRET },
        ports,
        signature: "v0=bad",
        timestamp: "100",
        rawBody: "{}",
      }),
    ).rejects.toThrow(/signature/);
  });
});

describe("slack handler — classifier tiers", () => {
  it("auto-spawns on a high-confidence coding task", async () => {
    const { ports, posts, spawns } = fakePorts({
      intent: async () => ({ isCodingTask: true, confidence: 0.9 }),
      router: async () => [{ repoId: "monolith", score: 0.95 }],
    });
    const env = await signedMention("fix the bug in monolith");
    const result = await handleSlackEvent({
      config: { signingSecret: SECRET },
      ports,
      ...env,
    });
    expect(result.kind).toBe("spawned");
    expect(spawns).toHaveLength(1);
    expect(posts[0]).toContain("monolith");
  });

  it("rejects a non-coding mention with a helpful message", async () => {
    const { ports, posts } = fakePorts({
      intent: async () => ({ isCodingTask: false, confidence: 0.2 }),
      router: async () => [],
    });
    const env = await signedMention("thanks @forge");
    const result = await handleSlackEvent({ config: { signingSecret: SECRET }, ports, ...env });
    expect(result.kind).toBe("rejected");
    expect(posts[0]).toContain("coding tasks");
  });

  it("posts a confirm message on medium confidence", async () => {
    const { ports, posts } = fakePorts({
      intent: async () => ({ isCodingTask: true, confidence: 0.9 }),
      router: async () => [{ repoId: "monolith", score: 0.65 }],
    });
    const env = await signedMention("fix it");
    const result = await handleSlackEvent({ config: { signingSecret: SECRET }, ports, ...env });
    expect(result.kind).toBe("decision");
    expect(posts[0]).toContain("Did you mean");
    expect(posts[0]).toContain("monolith");
  });

  it("posts a disambiguate list on a tie", async () => {
    const { ports, posts } = fakePorts({
      intent: async () => ({ isCodingTask: true, confidence: 0.9 }),
      router: async () => [
        { repoId: "a", score: 0.7 },
        { repoId: "b", score: 0.68 },
        { repoId: "c", score: 0.66 },
      ],
    });
    const env = await signedMention("fix it");
    const result = await handleSlackEvent({ config: { signingSecret: SECRET }, ports, ...env });
    expect(result.kind).toBe("decision");
    expect(posts[0]).toContain("Which repo?");
    expect(posts[0]).toContain("`a`");
    expect(posts[0]).toContain("`c`");
  });

  it("posts an explain message when no repo matches", async () => {
    const { ports, posts } = fakePorts({
      intent: async () => ({ isCodingTask: true, confidence: 0.9 }),
      router: async () => [{ repoId: "x", score: 0.2 }],
    });
    const env = await signedMention("do something vague");
    const result = await handleSlackEvent({ config: { signingSecret: SECRET }, ports, ...env });
    expect(result.kind).toBe("decision");
    expect(posts[0]).toContain("couldn't figure out");
  });
});

describe("slack handler — dedup (docs/19 §4)", () => {
  it("does not spawn a duplicate for the same (repo, branch, thread)", async () => {
    const { ports, posts, spawns } = fakePorts({
      intent: async () => ({ isCodingTask: true, confidence: 0.9 }),
      router: async () => [{ repoId: "monolith", score: 0.95 }],
      existing: { "monolith|main|C1:1700000000": "sess_existing_1" },
    });
    const env = await signedMention("fix it in monolith");
    const result = await handleSlackEvent({ config: { signingSecret: SECRET }, ports, ...env });
    expect(result.kind).toBe("duplicate");
    expect(spawns).toHaveLength(0); // no new spawn
    expect(posts[0]).toContain("already running");
    expect(posts[0]).toContain("sess_existing_1");
  });
});
