// Slack /slack/events handler (seam 4, docs/19 Part A, docs/08 §11, checklist §8.1).
// Verify the signing secret → parse the envelope → extract a trigger → run the
// classifier → act on the decision (auto-spawn / confirm / disambiguate / explain).
// Thread posting, dedup-store, and session-spawning are injected ports so the
// handler is fully testable without real Slack / Vectorize / the DO.

import { ForgeError } from "@forge/domain";
import {
  eventCallbackEnvelopeSchema,
  extractTrigger,
  slackEnvelopeSchema,
  urlVerificationEnvelopeSchema,
  type SlackTrigger,
} from "./types";
import {
  applyPolicy,
  classify,
  dedupKey,
  type ClassifierDecision,
  type RepoRouter,
} from "./classifier";
import type { IntentFilter } from "./classifier";
import { newCorrelationId } from "../otel/console";
import { verifySlackRequest } from "./verify";

/** Ports the Slack handler delegates to (testable; real impls wired in index.ts). */
export interface SlackPorts {
  intentFilter: IntentFilter;
  repoRouter: RepoRouter;
  /** Post a message to a Slack thread (returns the message ts). */
  postToThread(channel: string, threadTs: string, text: string): Promise<string>;
  /** Is a session already running for this dedup key? Returns the existing session id or null. */
  getExistingSession(dedupKey: string): Promise<string | null>;
  /** Spawn a session for a repo (returns the session id). */
  spawnSession(repoId: string, trigger: SlackTrigger): Promise<string>;
  /** The default branch for a repo (for the dedup key). */
  defaultBranchFor(repoId: string): Promise<string>;
}

export interface SlackHandlerConfig {
  signingSecret: string;
}

/** Result of handling a Slack request (for tests / observability). */
export type SlackHandlerResult =
  | { kind: "url_verification"; challenge: string }
  | { kind: "ignored"; reason: string }
  | { kind: "rejected"; reason: string; threadTs: string }
  | { kind: "spawned"; sessionId: string; repoId: string; tier: string; threadTs: string }
  | { kind: "duplicate"; existingSessionId: string; threadTs: string }
  | { kind: "decision"; decision: ClassifierDecision; threadTs: string };

/**
 * Handle a Slack Events API request end-to-end (docs/19 Part A).
 * Steps: verify → parse → extract trigger → classify → act.
 */
export async function handleSlackEvent(opts: {
  config: SlackHandlerConfig;
  ports: SlackPorts;
  signature: string | null;
  timestamp: string | null;
  rawBody: string;
  /** Override the current time for replay-window checks (tests). */
  nowSeconds?: number;
}): Promise<SlackHandlerResult> {
  const { config, ports } = opts;

  // 1. Verify the signing secret (reject forged/old requests).
  const valid = await verifySlackRequest({
    signingSecret: config.signingSecret,
    signature: opts.signature,
    timestamp: opts.timestamp,
    body: opts.rawBody,
    nowSeconds: opts.nowSeconds,
  });
  if (!valid) {
    throw new ForgeError({
      category: "auth",
      code: "SLACK_SIGNATURE_INVALID",
      message: "Slack request signature verification failed",
      correlationId: newCorrelationId(),
    });
  }

  // 2. Parse the envelope (Slack's schema — docs/10 §5).
  const parsed = slackEnvelopeSchema.safeParse(JSON.parse(opts.rawBody));
  if (!parsed.success) {
    return { kind: "ignored", reason: "unparseable envelope" };
  }
  const envelope = parsed.data;

  // 3. URL verification handshake (one-time setup).
  if (urlVerificationEnvelopeSchema.safeParse(envelope).success) {
    const handshake = envelope as { challenge: string };
    return { kind: "url_verification", challenge: handshake.challenge };
  }

  // 4. Extract a trigger from the event.
  const eventEnvelope = eventCallbackEnvelopeSchema.safeParse(envelope);
  if (!eventEnvelope.success) {
    return { kind: "ignored", reason: "unsupported event type" };
  }
  const trigger = extractTrigger(eventEnvelope.data);
  if (!trigger) {
    return { kind: "ignored", reason: "no actionable trigger (e.g. bot message)" };
  }

  // 5. Run the two-stage classifier.
  const { intent, candidates, decision } = await classify(
    { text: trigger.text },
    { intentFilter: ports.intentFilter, repoRouter: ports.repoRouter },
  );
  void intent;
  void candidates;

  // 6. Act on the decision (docs/19 §2).
  switch (decision.tier) {
    case "reject":
      await ports.postToThread(
        trigger.channel,
        trigger.threadTs,
        decision.reason.includes("not a coding")
          ? "I help with coding tasks — mention me with a code change request."
          : `Not spawning: ${decision.reason}`,
      );
      return { kind: "rejected", reason: decision.reason, threadTs: trigger.threadTs };

    case "explain":
      await ports.postToThread(
        trigger.channel,
        trigger.threadTs,
        "I couldn't figure out which repo — specify with `in <repo-name>`.",
      );
      return { kind: "decision", decision, threadTs: trigger.threadTs };

    case "disambiguate": {
      const list = decision.repoIds.map((r, i) => `${i + 1}. \`${r}\``).join("\n");
      await ports.postToThread(
        trigger.channel,
        trigger.threadTs,
        `Which repo? React with the matching number:\n${list}`,
      );
      return { kind: "decision", decision, threadTs: trigger.threadTs };
    }

    case "confirm":
      await ports.postToThread(
        trigger.channel,
        trigger.threadTs,
        `Did you mean \`${decision.repoId}\`? React ✅ to confirm.`,
      );
      return { kind: "decision", decision, threadTs: trigger.threadTs };

    case "auto_spawn":
      return spawnIfNotDuplicate(decision.repoId, trigger, ports);

    default:
      return { kind: "ignored", reason: `unhandled tier: ${(decision as { tier: string }).tier}` };
  }
}

/** Spawn a session unless one is already running for the dedup key (docs/19 §4). */
async function spawnIfNotDuplicate(
  repoId: string,
  trigger: SlackTrigger,
  ports: SlackPorts,
): Promise<SlackHandlerResult> {
  const branch = await ports.defaultBranchFor(repoId);
  const key = dedupKey(repoId, branch, trigger.slackThread);
  const existing = await ports.getExistingSession(key);
  if (existing) {
    await ports.postToThread(
      trigger.channel,
      trigger.threadTs,
      `A session is already running on \`${repoId}\`: ${existing}`,
    );
    return { kind: "duplicate", existingSessionId: existing, threadTs: trigger.threadTs };
  }
  const sessionId = await ports.spawnSession(repoId, trigger);
  await ports.postToThread(
    trigger.channel,
    trigger.threadTs,
    `Started session on \`${repoId}\`: ${sessionId}`,
  );
  return { kind: "spawned", sessionId, repoId, tier: "auto_spawn", threadTs: trigger.threadTs };
}

// Re-export the policy for direct testing.
export { applyPolicy };
