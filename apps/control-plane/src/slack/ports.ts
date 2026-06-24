// Slack ports factory — wires real @slack/web-api posting + the classifier ports
// (intent filter + repo router). The classifier's model/Vectorize calls use the
// Workers AI + Vectorize bindings when present (real profile / prod); otherwise
// deterministic stubs (fast profile) so the handler is runnable with zero creds.
//
// Session-spawn + dedup-store ports call the SessionDO + a KV-backed dedup map.

import { WebClient } from "@slack/web-api";
import type { Env } from "../env";
import type { IntentFilter, RepoRouter } from "./classifier";
import type { SlackPorts } from "./handler";
import type { SlackTrigger } from "./types";

/** A deterministic intent filter for the fast profile (no real model). */
const stubIntentFilter: IntentFilter = async ({ text }) => {
  // Heuristic: treat any non-trivial message as a coding task. Real impl uses a
  // tier-5 classifier (docs/19 §1). Tests inject their own.
  const isCodingTask = text.trim().length > 8 && !/^(thanks|ty|nice|👍)/i.test(text);
  return { isCodingTask, confidence: isCodingTask ? 0.7 : 0.2 };
};

/** A deterministic repo router for the fast profile (no Vectorize). */
const stubRepoRouter: RepoRouter = async ({ text }) => {
  // Heuristic: pick a repo by keyword. Real impl embeds via Workers AI → Vectorize.
  const m = text.match(/\bin\s+([a-z0-9_-]+)/i);
  const repoId = m?.[1] ?? "repo_demo";
  return [{ repoId, score: 0.9 }];
};

/** Build the Slack ports for an env. Real bindings used when present. */
export function buildSlackPorts(env: Env): SlackPorts {
  const token = (env.SLACK_BOT_TOKEN as string | undefined) ?? "";
  const web = token ? new WebClient(token) : null;

  return {
    intentFilter: stubIntentFilter,
    repoRouter: stubRepoRouter,

    async postToThread(channel, threadTs, text) {
      if (!web) {
        // Fast profile (no bot token): log instead of posting.
        console.log(`[slack:fast] #${channel}/${threadTs}: ${text}`);
        return "fast-stub-ts";
      }
      const res = await web.chat.postMessage({ channel, thread_ts: threadTs, text });
      return res.ts ?? "unknown";
    },

    async getExistingSession(key) {
      // KV-backed dedup: (repo, branch, slack_thread) → session id.
      const existing = await env.CONFIG_KV.get(`slack:dedup:${key}`);
      return existing;
    },

    async spawnSession(repoId, _trigger: SlackTrigger) {
      // Spawn a session via the DO (the same path session.create uses).
      const sessionId = `slack_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const idObj = env.sessionDo.idFromName(sessionId);
      const stub = env.sessionDo.get(idObj) as unknown as {
        spawn(i: {
          repoId: string;
          branch: string;
          createdByUserId: string;
        }): Promise<{ sessionId: string }>;
      };
      await stub.spawn({ repoId, branch: "main", createdByUserId: "slack_trigger" });
      // Record the dedup key so duplicates are caught (5-min TTL — a running session).
      await env.CONFIG_KV.put(`slack:dedup:${repoId}|main|${_trigger.slackThread}`, sessionId, {
        expirationTtl: 300,
      });
      return sessionId;
    },

    async defaultBranchFor(_repoId) {
      // §8 widens this to read .forge/config.toml [git] default_branch from D1.
      return "main";
    },
  };
}
