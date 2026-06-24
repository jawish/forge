# Getting started with Forge

Forge turns a Slack message, thread, or screenshot into an AI engineering session
that works in a full sandboxed copy of your repo, runs + verifies its changes, and
opens a PR under **your** GitHub identity.

## What you can do in 5 minutes

1. **From Slack:** mention `@forge` in a thread (or react 📌 on a message) with a
   coding request. Forge classifies it, picks the repo, and starts a session — all
   in the same Slack thread.
2. **From the Web:** open Forge, pick a repo, write a prompt, and watch the agent
   think + act + verify live, then approve the PR.

You don't need repo access configured, a local dev env, or to write any context —
Forge has the repo + tools + conventions already.

## Before you start

- You're behind Cloudflare Access (Google Workspace SSO). If you can reach Forge,
  you're authenticated.
- Your GitHub account must be linked for PR creation (Forge prompts you the first
  time you approve a PR — OAuth, per-user, never a shared bot).
- The repo you're targeting must be onboarded (ask your repo champion, or see the
  [champion guide](./champion-guide.md)).

## The two ways in

| Entry | Best for |
|---|---|
| **Slack** (`@forge` or 📌) | Quick bug fixes, "fix this", thread-driven work. Zero friction. |
| **Web** (`forge.internal.example.com`) | Complex tasks, dashboards, session replay, multiplayer, hosted VS Code. |

## What Forge will NOT do

- **Merge or deploy without you.** Human review + CI + branch protection are
  always on (docs/01 §4). Forge opens PRs; humans + CI merge them.
- **Run outside allowlisted repos/paths.** Strict scoping (docs/18 §2) — the agent
  can't touch `secrets/`, `.env*`, or paths the repo marked sensitive.
- **Hold your credentials.** Secrets inject at the network boundary (docs/18 §5);
  the agent never sees tokens.

## Next

- [Slack flow walkthrough](./slack-flow-walkthrough.md) — the primary 5-min path.
- [Web UI guide](./web-ui-guide.md) — for depth, replay, and dashboards.
