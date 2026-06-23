# Web UI guide

`forge.internal.example.com` — for complex tasks, dashboards, session replay, and
multiplayer. (Canonical journey: `docs/04_Interface_Design.md` Journey B.)

## Dashboard (home)

- **Session list:** searchable, filterable (mine / team / all) with status, repo,
  duration, outcome (PR link or "In progress").
- **Quick start:** repo dropdown (favorites + search), prompt textarea (with
  templates: "Fix bug…", "Add feature per Linear #…", "Investigate alert"),
  model selector (smart default).
- **Analytics strip:** org adoption, sessions this week, PR conversion, top savers.

## New session

Repo + branch + prompt → **Start session**. The session opens in the live view.

## Session detail (the high-value view)

Tabbed/split:

- **Stream/Log (live):** thinking summarized by default ("Reading 47 files…"),
  expand for raw. Tool calls grouped ("Explored checkout logic — 12 calls, 800ms").
- **Artifacts:** diff viewer, test results, screenshots carousel, telemetry.
- **Context & Timeline (replay-first):** scrub every prompt, tool call, model
  response, decision point. Click any step to "replay from here with a modified
  prompt" or inspect the exact context/model params. Correlated OTel waterfall.
- **Controls:** Pause/Stop, Continue with new prompt, Spawn sub-session, Open
  hosted VS Code, Create PR (with preview), Share/Invite collaborators, Export
  replay.

Multiplayer sidebar shows who's present + their attributed prompts.

## Hosted VS Code / terminal

Open code-server running in the **same** sandbox session (one click from Web).
Manual changes sync awareness to the agent; useful for visual debugging or when
the agent is stuck.

## PR preview modal

Before PR creation: agent summary + Review Agent critique (if enabled), key diffs,
artifacts tabs (tests, screenshots, telemetry), the policy banner ("Explicit user
approval required" or "Auto-create enabled after preview + Review Agent pass").
Primary action: **Create PR with my GitHub attribution & session link**.

## Why replay matters

Replay is primary for trust + debugging — "see exactly why it did X." It's also
the data flywheel's source (sanitized session traces → better prompts, tools,
defaults). Even live sessions have the full history scrubber.
