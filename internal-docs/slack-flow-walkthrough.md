# Slack flow — 5-minute walkthrough

The primary entry. Post a coding request in Slack; Forge handles the rest in the
same thread. (Canonical journey: `docs/04_Interface_Design.md` Journey A.)

## 1. Trigger (you)

In any channel where Forge is invited, either:

- **Mention it** in a message or thread:
  > `@forge` the checkout total is wrong on mobile after applying a promo — here's the repro `[screenshot]`
- **React** with 📌 on an existing message (useful for "turn this bug report into a fix").

That's it. No repo picker, no template, no "here's the context".

## 2. Forge classifies + replies (a few seconds)

Forge replies **in the thread**:

> 🔍 Starting Forge session for `frontend` repo…
> Classifier confidence: 92%. Session: `[link]`

The two-stage classifier (`docs/19` Part A):
- **Stage 1** decides if this is a coding task (not "thanks @forge").
- **Stage 2** routes to the repo (embed → Vectorize). If unsure, it asks you to
  confirm or disambiguate instead of guessing.

## 3. The agent works (live in the thread)

The thread updates as the agent runs in a sandboxed copy of the repo:

> Agent thinking… Reading recent changes to checkout components.
> Tool: `rg 'promo' --type tsx` (fast)
> Reproduced locally in sandbox. Running tests… 2 failures found.
> Fix applied. Re-running tests… ✅ All green. Screenshots captured (before/after).

## 4. Ready for review

> ✅ Ready. Proposed PR: `[link]`. Verified in Forge sandbox (session-abc123).
> Diff + test results + screenshots attached. Create PR with your attribution?

Reply **Create PR** (or react ✅), **Edit prompt & retry**, or **Add more context**.

## 5. PR created (under your identity)

Forge opens the PR **as you** (your GitHub OAuth, not a bot). Body includes the
session replay link, summary, verification artifacts, and `Co-authored-by: Forge Agent`.

> PR #1234 created. Human review + CI required as usual.

## Tips

- **Specify the repo if ambiguous:** "fix the bug **in frontend-monolith**" →
  skips the confirm step.
- **Add a screenshot** for visual bugs — the agent's vision verifies the fix.
- **Dedup:** if a session is already running for the same repo+thread, Forge links
  you to it instead of starting a duplicate.
- **Status updates** post to the thread at every transition (started, ready, failed, merged).

## What the agent can't touch

Per the repo's `.forge/config.toml [paths]`, the agent can't read/write `secrets/`,
`.env*`, `*.pem`, or anything the repo marked sensitive. It never holds credentials
— those inject at the network boundary. (docs/18 §2, §5.)

## Troubleshooting

- **"I couldn't figure out which repo"** → add `in <repo-name>` to your message.
- **No reply** → Forge only responds to mentions in channels it's invited to. Ask
  in `#forge-support`.
- **Session stuck** → see [troubleshooting](./troubleshooting.md).
