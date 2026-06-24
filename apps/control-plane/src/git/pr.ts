// Git & PR (seam 4 GitHub webhooks, docs/04, docs/11 §4, checklist §8.3).
// Pure logic for the PR surface:
// - branch naming: forge/<user>/<shortid>-<slug>
// - PR body composition: session link + summary + artifacts + Co-authored-by
// - human-approval gate (always on — docs/04 §6, docs/11 §6)
// - GitHub webhook parsing (PR merged/closed → terminal transitions)
//
// The actual GitHub OAuth + App API calls need the GitHub App credentials (§6/§8
// provisioning); the branch/body/webhook logic here is fully testable without them.

/** Generate the Forge branch name: forge/<user>/<shortid>-<slug> (docs/04 §6). */
export function forgeBranchName(opts: { user: string; sessionId: string; slug: string }): string {
  const shortid = opts.sessionId.replace(/^sess_/, "").slice(0, 8);
  const slug = slugify(opts.slug);
  return `forge/${opts.user}/${shortid}-${slug}`;
}

/** Slugify a summary into a branch/PR-safe slug. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Inputs to the PR body composer. */
export interface PrBodyInput {
  sessionLink: string;
  summary: string;
  /** Artifact links (R2 URIs or human-readable labels). */
  artifacts: Array<{ label: string; uri: string }>;
  /** The human user's GitHub username (for the co-author trailer). */
  userGithub: string;
}

/** Compose the PR body: session link + summary + artifacts + co-author (docs/04 §6). */
export function composePrBody(input: PrBodyInput): string {
  const lines: string[] = [];
  lines.push(`## Summary`, "", input.summary, "");
  lines.push(`## Session`, "", `Replay: ${input.sessionLink}`, "");
  if (input.artifacts.length > 0) {
    lines.push(`## Verification artifacts`, "");
    for (const a of input.artifacts) {
      lines.push(`- [${a.label}](${a.uri})`);
    }
    lines.push("");
  }
  lines.push(
    "---",
    "",
    "_Created by [Forge](https://forge.internal.example.com). Human review + CI + branch protection required as usual._",
    "",
    `Co-authored-by: ${input.userGithub} <${input.userGithub}@users.noreply.github.com>`,
    "Co-authored-by: Forge Agent <forge@noreply.example.com>",
  );
  return lines.join("\n");
}

/**
 * The human-approval gate (docs/04 §6, docs/11 §6). PR creation from
 * ready_for_pr → pr_open ALWAYS requires explicit human approval. This gate is
 * never bypassable (no auto-merge). Returns whether approval is satisfied.
 */
export function isPrApprovalSatisfied(approval: {
  approved: boolean;
  approverUserId: string | null;
}): boolean {
  // The gate is "approved by a real user" — never auto-approved.
  return approval.approved && approval.approverUserId !== null;
}

// --- GitHub webhook parsing (seam 4, docs/10 §5) ---------------------------

/** The minimal PR-action shape Forge acts on from a GitHub webhook. */
export interface PullRequestWebhook {
  action: "opened" | "closed" | "reopened";
  pull_request: {
    number: number;
    html_url: string;
    merged: boolean;
    head_ref: string; // the branch name — links to the session
  };
}

/** Map a PR webhook action to a session terminal transition (docs/11 §4). */
export function webhookToTransition(webhook: PullRequestWebhook): {
  status: "merged" | "closed" | null;
  reason: string;
} {
  if (webhook.action === "closed") {
    if (webhook.pull_request.merged) {
      return { status: "merged", reason: "pr_merged" };
    }
    return { status: "closed", reason: "pr_closed" };
  }
  // opened/reopened don't drive terminal transitions (the DO is already pr_open).
  return { status: null, reason: `pr_${webhook.action}` };
}

/** Extract the session id from a Forge branch name (forge/<user>/<shortid>-<slug>). */
export function sessionIdFromBranch(branch: string): string | null {
  const m = branch.match(/^forge\/[^/]+\/([a-z0-9]+)-/);
  return m?.[1] ?? null;
}
