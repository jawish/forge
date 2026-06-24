// Slack event payload schemas (seam 4 — docs/10 §5: parse their schema, not ours).
// Minimal subset of the Slack Events API payloads Forge handles: app_mention,
// message, url_verification (the handshake). zod parses + validates on ingest.

import { z } from "zod";

/** Slack's url_verification handshake (one-time setup). */
export const urlVerificationEnvelopeSchema = z.object({
  token: z.string(),
  challenge: z.string(),
  type: z.literal("url_verification"),
});
export type UrlVerificationEnvelope = z.infer<typeof urlVerificationEnvelopeSchema>;

/** The inner event for an app_mention. */
export const appMentionEventSchema = z.object({
  type: z.literal("app_mention"),
  user: z.string(),
  text: z.string(),
  ts: z.string(), // Slack message timestamp (used as the thread parent)
  thread_ts: z.string().optional(), // present if the mention is in a thread
  channel: z.string(),
});

/** The inner event for a message (used for reaction-triggered flows). */
export const messageEventSchema = z.object({
  type: z.literal("message"),
  user: z.string(),
  text: z.string(),
  ts: z.string(),
  thread_ts: z.string().optional(),
  channel: z.string(),
  subtype: z.string().optional(),
});

/** An Events API envelope wrapping an event. */
export const eventCallbackEnvelopeSchema = z.object({
  token: z.string(),
  team_id: z.string(),
  api_app_id: z.string(),
  event: z.union([appMentionEventSchema, messageEventSchema]),
  type: z.literal("event_callback"),
  event_id: z.string(),
  event_ts: z.string(),
});
export type EventCallbackEnvelope = z.infer<typeof eventCallbackEnvelopeSchema>;

/** A reaction_added event (📌 reaction triggers a session, docs/19 §4). */
export const reactionAddedEventSchema = z.object({
  type: z.literal("reaction_added"),
  user: z.string(),
  reaction: z.string(),
  item: z.object({
    type: z.string(),
    channel: z.string(),
    ts: z.string(),
  }),
});

/** Any Slack Events API envelope Forge might receive. */
export const slackEnvelopeSchema = z.union([
  urlVerificationEnvelopeSchema,
  eventCallbackEnvelopeSchema,
  z.object({
    token: z.string(),
    team_id: z.string(),
    api_app_id: z.string(),
    event: reactionAddedEventSchema,
    type: z.literal("event_callback"),
    event_id: z.string(),
    event_ts: z.string(),
  }),
]);

/** The canonical trigger Forge extracts from any Slack event. */
export interface SlackTrigger {
  kind: "app_mention" | "reaction";
  userId: string;
  text: string;
  channel: string;
  /** The message ts to thread Forge's responses under (docs/19 §4). */
  threadTs: string;
  /** The Forge-internal dedup key source: (repo, branch, slack_thread). */
  slackThread: string;
}

/**
 * Extract a canonical SlackTrigger from an Events API envelope. Returns null for
 * events Forge doesn't act on (bot messages, unsupported types).
 */
export function extractTrigger(envelope: EventCallbackEnvelope): SlackTrigger | null {
  const event = envelope.event;
  if (event.type === "message" && event.subtype) return null; // skip bot/system subtypes
  if (event.type === "app_mention" || event.type === "message") {
    const threadTs = event.thread_ts ?? event.ts; // thread under the triggering message
    return {
      kind: event.type === "app_mention" ? "app_mention" : "reaction",
      userId: event.user,
      text: event.text,
      channel: event.channel,
      threadTs,
      slackThread: `${event.channel}:${threadTs}`,
    };
  }
  return null;
}
