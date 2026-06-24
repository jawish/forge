# Troubleshooting

Common situations + where to get help. For the full error model, see
`docs/15_Error_Model.md`.

## Session issues

| Symptom | Likely cause | Fix |
|---|---|---|
| "I couldn't figure out which repo" | Stage-2 router low confidence | Add `in <repo-name>` to your message. |
| Session stuck (no progress) | Stuck-detector tripped (`docs/11` §5) | Pause + add context, or cancel. Sustained → `#forge-support`. |
| Session failed: budget exhausted | Per-session budget cap hit (`[policy] budget_limit_usd`) | Raise the cap (champion) or split the task. |
| Session failed: provisioning | Image pull / capacity (`SANDBOX_PROVISIONING_FAILED`) | Transient — retry. Repeated → Platform (image or CF Sandbox capacity). |
| No reply in Slack | Forge not invited to the channel | Invite `@forge`, or ask in `#forge-support`. |
| Duplicate session | Dedup caught a running session for the same repo+thread | Forge links you to the existing session. |

## PR issues

| Symptom | Fix |
|---|---|
| "GitHub identity not linked" | Approve the PR once; Forge runs the per-user OAuth flow (docs/08 §10). |
| PR creation failed: `GIT_IDENTITY_ERROR` | Your OAuth token expired — re-link in Forge Web → Settings. |
| Branch protection / CI blocked merge | Expected — Forge never bypasses these (docs/01 §4). Fix the CI failure. |

## The error format

Every error carries a `correlationId` (e.g. `XYZ123`). Share it with support:

> Error XYZ123: {message}. Share code XYZ123 with support.

The category drives the action (docs/15 §2): `auth`/`not_found`/`invalid_input`
→ fix your input; `budget_exhausted` → raise the cap; `transient` → auto-retries;
`upstream_failure` → provider issue, surfaces after retry; `internal` → page Platform.

## Support

- `#forge-support` (Slack) — first stop.
- Share the `correlationId` + session link.
- For security concerns (suspected secret exposure, sandbox boundary question):
  DM Platform Security directly — don't post in open channels.
