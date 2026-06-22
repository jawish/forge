# Forge Interface Design & User Experience
**Version**: 1.1 (Refined)  
**Principles**: Slack-first zero-friction entry; Web for depth/control/replay; In-sandbox tools feel native; multiplayer natural; transparency on agent actions without noise. Mobile-responsive + accessible.

## 1. Core User Journeys (Textual Wireframes + Flow)

### Journey A: Slack-Native Bug Fix (Primary, Highest Leverage — Ramp Viral Pattern)
1. **Trigger**: Engineer or PM posts in #eng-bugs or thread: "Checkout flow shows wrong total on mobile after promo apply [screenshot]". Or reacts with :forge: emoji on existing message.
2. **Immediate Feedback** (Slack Bot):
   - Bot replies in thread: "🔍 Starting Forge session for `frontend` repo... Classifier confidence: 92%. Session: [link]"
   - Rich preview or Block Kit: repo icon, prompt summary, "Agent will investigate + propose verified fix".
3. **Session Starts** (real-time):
   - Thread updates live: "Agent thinking... Reading recent changes to checkout components."
   - "Tool: rg 'promo' --type tsx (fast)"
   - Progress: "Reproduced locally in sandbox. Running tests... 2 failures found."
   - "Fix applied. Re-running tests... ✅ All green. Screenshots captured (before/after)."
4. **Ready for Review**:
   - Bot posts: "✅ Ready. Proposed PR: [link]. Verified in Forge sandbox (session-abc123). Diff + test results + screenshots attached. Ready to create PR with your attribution?"
   - Buttons or quick reply: "Create PR" / "Edit prompt & retry" / "Add more context".
5. **PR Created** (user approves or auto per config):
   - PR opens with user's identity. Body: session link, summary, artifacts. "Co-authored-by: Forge".
   - Thread updated: "PR #1234 created. Human review + CI required as usual."
6. **Collaboration** (optional): Teammate joins Web session or continues in Slack; all prompts attributed.

**Why it works**: No repo picker, no rewritten ticket, no "here's the context". Original message + screenshot + thread = enough. Feels magic.

### Journey B: Web UI — Complex Task or Dashboard
**Dashboard (Home)**:
- Searchable list of active/recent sessions (mine, team, all) with status, repo, duration, outcome (PR link or "In progress").
- Quick-start form: Repo dropdown (favorites + search), prompt textarea (with templates: "Fix bug...", "Add feature X per spec in Linear #123", "Investigate alert"), model selector (default smart), "Start Session".
- Analytics strip: Org adoption %, sessions this week, conversion to PR, top time-savers.
- "Live humans prompting" (last 5min) like Ramp stats page.

**Session Detail View** (real-time + Replay — high-value from day one):
- Split or tabbed: 
  - **Stream/Log** (live): Live thinking summarized, tool calls grouped/expandable, progress bars.
  - **Artifacts** (live + historical): Diff viewer, test results, screenshots carousel, telemetry, review critiques.
  - **Context & Timeline** (replay-first): Full chronological scrubber of every PROMPT, TOOL_CALL, model response, artifact, decision point. Click any step to "replay agent from here with modified prompt" or inspect exact context/model params. Correlated OTel waterfall view. Sanitized for readability.
  - **Controls**: "Pause/Stop", "Continue with new prompt", "Spawn sub-session", "Open in hosted VS Code", "Create PR" (with preview), "Share / Invite collaborators", "Export replay for incident review".
- Multiplayer sidebar: Avatars of current participants + "User X joined and said...".
- **Replay mode is primary for trust & debugging**: Even live sessions have full history scrubber. Enables "see exactly why it did X" — core to Ramp-style data flywheel and rapid iteration.

**Hosted VS Code / Terminal**:
- Embed or new tab: code-server running in the *same* sandbox session.
- Changes made manually sync awareness to agent (or agent observes FS).
- Useful for visual debugging, teaching non-eng, or when agent stuck.

**Chrome Extension (v1.1 or optional)**:
- For React-heavy apps: Sidebar chat + "Select element" tool (extracts DOM/React tree cheaply, no full screenshot tokens).
- "Highlight bug → Describe → Start Forge session on frontend repo".

### Journey C: Automation / Background (No Human Start)
1. Alert fires in Grafana/ClickHouse or cron triggers.
2. Automation service (or webhook) → Forge Integration Layer → creates background session with templated prompt + full context (alert payload, recent deploys, ownership).
3. Session runs on **flex tier** (cheaper/slower OK) unless high-priority incident (fast path).
4. Result: Structured report posted back to incident thread/Linear + optional proposed PR (or "no code change needed, root cause X").
5. Deduping prevents duplicate sessions for same fingerprint.

**Review Agents** (v1.1):
- On PR creation or "ready" signal from Forge session: Review Buddy (multi-model) runs in parallel or sequential.
- Posts comments or creates improved branch: "Security: potential IDOR here... Suggested fix: ...", "Perf: N+1 query detected", "Tests: coverage gap on edge case".
- Human sees pre-vetted PR.

## 2. Key Screens & Interaction Patterns (Descriptive Wireframes)

**Slack Message (Bot Output Example)**:
```
@Forge • Session started for frontend-monolith
Investigating: Wrong total in checkout after promo on mobile.
Context: Thread + screenshot analyzed (vision).
Status: Running tests in sandbox... (2m elapsed)
[View full session in Forge →]
```

**Web Session List** (table + cards):
Columns: Session ID | Repo | Started by | Duration | Status (Running / Awaiting input / Ready for PR / Merged) | Outcome | Actions (Join / View / Retry)

**Prompt Composer** (Web or Slack):
- Rich: @mentions for files/tools? Or natural language.
- Context chips: "Include recent commits", "Focus on X service", "Visual verification required".
- Model/reasoning selector with cost estimate preview (advanced).

**PR Preview Modal** (before create — triggered from Slack "Ready?" button via deep link or directly in Web):
- Summary generated by agent + Review Agent critique (if enabled for repo).
- Key diffs (unified or side-by-side) with inline review comments if any.
- Artifacts tabs (tests green/red, screenshots before/after with captions, telemetry snapshots, feature flag impact).
- Policy banner: "Per-repo policy: Explicit user approval required before PR creation" (or "Auto-create enabled after this preview + Review Agent pass").
- Primary action: "Create PR with my GitHub attribution & session link" (or auto per policy). Secondary: "Edit prompt & retry", "Add more context", "Spawn sub-task for investigation".
- Footer: "This will create branch `forge/jawish/session-xyz-fix-checkout`. CI + branch protection + human reviewers required. Full session replay linked in PR body. Co-authored-by: Forge Agent."

## 3. Design System & Polish Notes
- **Branding**: Professional, trustworthy, fast. Dark mode default (eng preference). Accent color (e.g., Ramp-like or company blue). Subtle animations on streaming (not distracting).
- **Transparency without Overwhelm**: Agent "thinking" summarized by default ("Reading 47 files..."); expand for raw. Tool calls grouped ("Explored checkout logic (12 tool calls, 800ms)").
- **Error States & Recovery**: Clear "Agent encountered rate limit on model X — retrying with fallback in 5s" or "Tool timeout on long test — partial results available. Continue?" One-click actions.
- **Accessibility**: ARIA labels, keyboard nav, high contrast, screen-reader friendly logs (text alternatives for visuals).
- **Performance Perception**: Optimistic UI (session appears instantly), skeleton loaders, progressive disclosure. Real perf from architecture (warm sandboxes, direct WS).
- **Mobile**: Slack primary on phone; Web responsive (dashboard collapses, session stream readable).

## 4. Information Architecture
- **Global Nav (Web)**: Dashboard | My Sessions | Team Activity | Analytics | Repo Settings (per-repo tuning, images) | Admin (if permitted).
- **Session as First-Class Entity**: Permalinkable, searchable, filterable by outcome/repo/user/date.
- **Settings Hierarchy**: User prefs (default model, notifications) → Repo Settings (image Dockerfile/setup.sh, prewarm commands, MCP allowlist, sensitive paths, tuning params, Review Policy, Automation rules — self-service wizard with validation build + cold-start benchmark) → Org defaults & global policies.
- **Repo Settings UI details**: Wizard flow for owners (edit → validate build in sandbox → preview warm time/metrics → version & submit). Permissions: Repo owners/maintainers can edit their repo; sensitive changes require Platform approval. History/diff of configs. Staleness alerts.

**Sub-Session Spawn UI** (from Session Detail Controls):
- Modal: "Spawn parallel investigation or sub-task". Fields: Target repo (default inherit or picker), Prompt (inherit context or new), "Link as child of current session". Shows estimated cost/impact. Parent session shows live status of children with links. Results aggregated in parent artifacts or linked.

## 5. Metrics for UX Success (from PRD)
- Time from trigger (Slack reaction) to first agent output <5s.
- Session → actionable PR or clear "no change needed" outcome rate >40%.
- User-reported "friction" low (setup time 0, guiding agent minimal).
- Multiplayer usage grows (indicates collaboration value).
- Non-eng adoption via visual/Slack paths.

This design makes Forge feel like an extension of existing workflows rather than a new tool to learn. Slack entry + verification artifacts + attribution = high trust and adoption, matching Ramp's 98.6% org penetration.

*Refined: Added explicit automation & review agent flows, stronger emphasis on artifacts for fast human review, recovery UX, cost preview in composer.*