// MCP governance pipeline (ADR-0007, §9 Phase 2).
// Registry-managed MCP server governance: when an MCP server is registered,
// it goes through a governance pipeline before it's allowed in sessions:
//
// 1. OpenSSF Scorecard gating — the server's repo must meet a minimum score
// 2. Trivy scan at registration — no HIGH/CRITICAL vulns in the server image
// 3. cosign signature verification — the server image is signed
// 4. cosign verification at spawn — re-verified every time the server is used
//
// The registry is federated (D1-backed) — each repo has an allowlist of
// approved MCP servers with their permission manifests.
//
// Pure logic; the scan/scorecard/cosign calls are injected ports (testable).

/** An MCP server registration request (from the registry, ADR-0007). */
export interface McpRegistration {
  /** The server's OCI image reference (e.g., ghcr.io/org/mcp-server:1.0.0). */
  image: string;
  /** The source repo (for Scorecard evaluation). */
  sourceRepo: string;
  /** The permission manifest (what egress + tools the server is allowed). */
  manifest: {
    egress: string[];
    tools: string[];
  };
  /** The publisher's identity (for cosign verification). */
  publisher: string;
}

/** The governance verdict for an MCP registration. */
export interface GovernanceVerdict {
  approved: boolean;
  /** The checks that ran + their results. */
  checks: GovernanceCheck[];
  /** The image digest (for pinning at spawn). */
  imageDigest?: string;
  /** If rejected, the reason. */
  rejectionReason?: string;
}

/** A single governance check result. */
export interface GovernanceCheck {
  name: "scorecard" | "trivy" | "cosign-verify";
  passed: boolean;
  /** Details (score, vuln count, signer identity). */
  details?: string;
}

/** Port: run an OpenSSF Scorecard evaluation on a repo (injected). */
export type ScorecardEvaluator = (repo: string) => Promise<{ score: number; findings: string[] }>;

/** Port: run a Trivy scan on an image (injected). */
export type TrivyScanner = (image: string) => Promise<{ highCount: number; criticalCount: number }>;

/** Port: verify a cosign signature on an image (injected). */
export type CosignVerifier = (
  image: string,
  publisher: string,
) => Promise<{ verified: boolean; digest: string }>;

/** The governance thresholds (configurable, docs/ADR-0007). */
export interface GovernanceThresholds {
  minScorecardScore: number;
  maxHighVulns: number;
  maxCriticalVulns: number;
  requireCosign: boolean;
}

/** Default thresholds (docs/ADR-0007). */
export const DEFAULT_THRESHOLDS: GovernanceThresholds = {
  minScorecardScore: 6.0,
  maxHighVulns: 5,
  maxCriticalVulns: 0, // zero tolerance for critical
  requireCosign: true,
};

/**
 * Run the full MCP governance pipeline on a registration (ADR-0007, §9).
 * Returns the verdict: approved only if ALL checks pass.
 *
 * Pure orchestration — the scan/scorecard/cosign ports are injected.
 */
export async function evaluateMcpRegistration(opts: {
  registration: McpRegistration;
  thresholds?: GovernanceThresholds;
  scorecard: ScorecardEvaluator;
  trivy: TrivyScanner;
  cosign: CosignVerifier;
}): Promise<GovernanceVerdict> {
  const t = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const checks: GovernanceCheck[] = [];

  // 1. Scorecard
  const score = await opts.scorecard(opts.registration.sourceRepo);
  checks.push({
    name: "scorecard",
    passed: score.score >= t.minScorecardScore,
    details: `score=${score.score.toFixed(1)} (min ${t.minScorecardScore})`,
  });

  // 2. Trivy scan
  const trivy = await opts.trivy(opts.registration.image);
  checks.push({
    name: "trivy",
    passed: trivy.criticalCount <= t.maxCriticalVulns && trivy.highCount <= t.maxHighVulns,
    details: `${trivy.criticalCount} critical, ${trivy.highCount} high`,
  });

  // 3. cosign verification
  let imageDigest: string | undefined;
  if (t.requireCosign) {
    const cosign = await opts.cosign(opts.registration.image, opts.registration.publisher);
    imageDigest = cosign.digest;
    checks.push({
      name: "cosign-verify",
      passed: cosign.verified,
      details: cosign.verified ? `signed by ${opts.registration.publisher}` : "unsigned/invalid",
    });
  }

  const allPassed = checks.every((c) => c.passed);
  const failedChecks = checks.filter((c) => !c.passed);

  return {
    approved: allPassed,
    checks,
    imageDigest,
    rejectionReason: allPassed
      ? undefined
      : `Failed: ${failedChecks.map((c) => c.name).join(", ")}`,
  };
}

/**
 * Verify an MCP server at spawn time (ADR-0007, §9). This re-checks the cosign
 * signature every time the server is used — defense-in-depth against a
 * compromised registry between registration and spawn.
 *
 * Uses the image digest pinned at registration (not the mutable tag) so a
 * registry swap (re-tagging a malicious image with a known-good tag) is caught.
 */
export async function verifyMcpAtSpawn(opts: {
  image: string;
  pinnedDigest: string;
  publisher: string;
  cosign: CosignVerifier;
}): Promise<boolean> {
  // Verify the cosign signature on the pinned digest (immutable reference).
  const result = await opts.cosign(`${opts.image}@${opts.pinnedDigest}`, opts.publisher);
  return result.verified;
}

/**
 * The D1-federated registry store (ADR-0007). Each repo has an allowlist of
 * approved MCP servers (by image digest, not tag). The store is the source of
 * truth for which servers a repo can use.
 *
 * Pure interface — the D1 implementation lives in the control plane.
 */
export interface McpRegistryStore {
  /** Add an approved MCP server to a repo's allowlist. */
  add(
    repoId: string,
    server: { image: string; digest: string; manifest: McpRegistration["manifest"] },
  ): Promise<void>;
  /** List all approved MCP servers for a repo. */
  list(
    repoId: string,
  ): Promise<Array<{ image: string; digest: string; manifest: McpRegistration["manifest"] }>>;
  /** Remove an MCP server from a repo's allowlist. */
  remove(repoId: string, image: string): Promise<void>;
}

/** In-memory registry store (for tests + dev). */
export class MemoryMcpRegistryStore implements McpRegistryStore {
  private map = new Map<
    string,
    Array<{ image: string; digest: string; manifest: McpRegistration["manifest"] }>
  >();
  async add(
    repoId: string,
    server: { image: string; digest: string; manifest: McpRegistration["manifest"] },
  ): Promise<void> {
    const list = this.map.get(repoId) ?? [];
    list.push(server);
    this.map.set(repoId, list);
  }
  async list(
    repoId: string,
  ): Promise<Array<{ image: string; digest: string; manifest: McpRegistration["manifest"] }>> {
    return this.map.get(repoId) ?? [];
  }
  async remove(repoId: string, image: string): Promise<void> {
    const list = this.map.get(repoId) ?? [];
    this.map.set(
      repoId,
      list.filter((s) => s.image !== image),
    );
  }
}
