// Path scoping — sanitization layer 1 (docs/18 §2, docs/13 §2 [paths], checklist §8.2).
// The agent is constrained by the repo's `[paths]` config:
//   sensitive = cannot read OR write (secrets/, .env*, *.pem, *.key)
//   readonly  = can read but not write (docs/policies/**)
// Plus the safe-edit decision: an edit is "safe" iff its target path is writable
// AND it's a patch (not a wholesale delete of a large file). Pure logic — testable.

/** Compile a list of glob patterns into a matcher (minimatch-style, subset). */
export class GlobMatcher {
  private readonly patterns: ReadonlyArray<RegExp>;
  constructor(globs: ReadonlyArray<string>) {
    this.patterns = globs.map((g) => new RegExp(`^${globToRegex(g)}$`));
  }
  /** Does `path` match any of the patterns? */
  matches(path: string): boolean {
    return this.patterns.some((p) => p.test(path));
  }
}

/** Convert a glob to a regex (subset: *, **, ?, literals). */
function globToRegex(glob: string): string {
  // Escape regex specials except our glob chars, then translate glob syntax.
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      out += ".*";
      i++; // consume both stars
      if (glob[i + 1] === "/") i++; // consume trailing slash after **
    } else if (c === "*") {
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if ("/.+^${}()|[]\\".includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return out;
}

/** The compiled path-scope rules for a repo (from .forge/config.toml [paths]). */
export interface PathScope {
  sensitive: GlobMatcher; // agent cannot read OR write
  readonly: GlobMatcher; // agent can read but not write
}

/** Build a PathScope from the raw [paths] config. */
export function buildPathScope(paths: {
  sensitive: ReadonlyArray<string>;
  readonly: ReadonlyArray<string>;
}): PathScope {
  return {
    sensitive: new GlobMatcher(paths.sensitive),
    readonly: new GlobMatcher(paths.readonly),
  };
}

/** The access decision for a path + operation. */
export type AccessDecision = "allow" | "deny_sensitive" | "deny_readonly_write";

/** Check whether an operation on a path is allowed (docs/18 §2). */
export function checkAccess(scope: PathScope, path: string, op: "read" | "write"): AccessDecision {
  if (scope.sensitive.matches(path)) return "deny_sensitive"; // never read OR write
  if (op === "write" && scope.readonly.matches(path)) return "deny_readonly_write";
  return "allow";
}

// --- Safe edit (patches) — docs/01, checklist §8.2 -------------------------

/** A file edit the agent proposes (patch form). */
export interface ProposedEdit {
  path: string;
  /** The new full content (or null for a delete). */
  newContent: string | null;
}

/** Result of validating an edit against the path scope + safe-edit rules. */
export interface EditValidation {
  allowed: boolean;
  reason?: string;
}

/**
 * Validate a proposed edit (docs/01 safe-edit, checklist §8.2). An edit is safe iff:
 * - the target path is writable (not sensitive, not readonly)
 * - it's not a wholesale delete of a file (deletes require explicit confirmation)
 *
 * Path scoping is sanitization layer 1 — the agent never edits secrets/ (docs/18 §2).
 */
export function validateEdit(scope: PathScope, edit: ProposedEdit): EditValidation {
  const access = checkAccess(scope, edit.path, "write");
  if (access === "deny_sensitive") {
    return { allowed: false, reason: `path ${edit.path} is sensitive (cannot edit)` };
  }
  if (access === "deny_readonly_write") {
    return { allowed: false, reason: `path ${edit.path} is readonly (cannot edit)` };
  }
  if (edit.newContent === null) {
    return { allowed: false, reason: "delete requires explicit confirmation (not a safe edit)" };
  }
  return { allowed: true };
}

/** Validate a batch of edits; returns the first failure or all-allowed. */
export function validateEdits(
  scope: PathScope,
  edits: ReadonlyArray<ProposedEdit>,
): { allowed: boolean; failures: Array<{ edit: ProposedEdit; reason: string }> } {
  const failures: Array<{ edit: ProposedEdit; reason: string }> = [];
  for (const edit of edits) {
    const v = validateEdit(scope, edit);
    if (!v.allowed && v.reason) failures.push({ edit, reason: v.reason });
  }
  return { allowed: failures.length === 0, failures };
}
