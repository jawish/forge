// Platform-provided MCP tools (seam 5, docs/10 §6, checklist §5.15).
// forge.reportStatus / forge.createArtifact / forge.requestHumanInput / forge.completePR.
//
// Implemented as a thin tool dispatcher: tool definitions (MCP-compatible shape)
// + callTool(name, args, sessionId) → DO method. Errors return agent-safe
// ({category, retryable, message} only — no stack, no secrets; docs/15 §4).
// OpenCode in the sandbox is configured to call these (docs/19 §7 configure-don't-fork).

import { ForgeError, type ForgeErrorCategory } from "@forge/domain";
import type { Env } from "../env";
import { newCorrelationId } from "../otel/console";

/** MCP tool definition (MCP-compatible shape). */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

/** The 4 platform-provided MCP tools (docs/10 §6). */
export const FORGE_MCP_TOOLS: readonly McpTool[] = [
  {
    name: "forge.reportStatus",
    description: "Agent tells the control plane its current activity + summary.",
    inputSchema: {
      type: "object",
      properties: {
        activity: {
          type: "string",
          description: "running|awaiting_input|paused|stuck",
        },
        summary: { type: "string", description: "free-text progress summary" },
      },
      required: [],
    },
  },
  {
    name: "forge.createArtifact",
    description: "Agent produces a durable output (diff/screenshot/report/...).",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description: "diff|test_result|screenshot|telemetry|report|review_critique",
        },
        storageUri: { type: "string", description: "R2 URI where the blob lives" },
        generatedBy: { type: "string", description: "agent|user|review_agent" },
      },
      required: ["type", "storageUri", "generatedBy"],
    },
  },
  {
    name: "forge.requestHumanInput",
    description: "Agent asks a clarifying question (sets activity=awaiting_input).",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
  },
  {
    name: "forge.completePR",
    description: "Agent signals readiness for PR creation (status=ready_for_pr).",
    inputSchema: {
      type: "object",
      properties: {
        diffSummary: { type: "string" },
        commitSha: { type: "string" },
      },
      required: ["diffSummary", "commitSha"],
    },
  },
];

/** The DO RPC shape these tools call. */
interface SessionDOStub {
  reportStatus(s: {
    activity?: "provisioning" | "running" | "awaiting_input" | "paused" | "stuck";
    summary?: string;
  }): Promise<void>;
  createArtifact(a: {
    type: string;
    storageUri: string;
    generatedBy: string;
    mimeType?: string;
    sizeBytes?: number;
    metadataJson?: string;
  }): Promise<{ artifactId: string }>;
  requestHumanInput(q: string): Promise<void>;
  completePR(c: { diffSummary: string; commitSha: string }): Promise<void>;
}

/** Result of a tool call — either the data or an agent-safe error (docs/15 §4). */
export type ToolCallResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { category: ForgeErrorCategory; retryable: boolean; message: string } };

/**
 * Call a platform MCP tool against a session's DO. Routes by tool name to the
 * matching DO method; returns agent-safe errors only (no stack, no secrets).
 */
export async function callTool(
  toolName: string,
  args: Record<string, unknown>,
  sessionId: string,
  env: Env,
): Promise<ToolCallResult> {
  const stub = env.sessionDo.idFromName(sessionId);
  const doStub = env.sessionDo.get(stub) as unknown as SessionDOStub;
  try {
    switch (toolName) {
      case "forge.reportStatus":
        await doStub.reportStatus({
          activity: args.activity as
            | "provisioning"
            | "running"
            | "awaiting_input"
            | "paused"
            | "stuck"
            | undefined,
          summary: args.summary as string | undefined,
        });
        return { ok: true, data: { acknowledged: true } };

      case "forge.createArtifact": {
        const r = await doStub.createArtifact({
          type: args.type as string,
          storageUri: args.storageUri as string,
          generatedBy: args.generatedBy as "agent" | "user" | "review_agent",
          mimeType: args.mimeType as string | undefined,
          sizeBytes: args.sizeBytes as number | undefined,
          metadataJson: args.metadataJson as string | undefined,
        });
        return { ok: true, data: r };
      }

      case "forge.requestHumanInput":
        await doStub.requestHumanInput(args.question as string);
        return { ok: true, data: { acknowledged: true } };

      case "forge.completePR":
        await doStub.completePR({
          diffSummary: args.diffSummary as string,
          commitSha: args.commitSha as string,
        });
        return { ok: true, data: { acknowledged: true } };

      default:
        return {
          ok: false,
          error: {
            category: "invalid_input",
            retryable: false,
            message: `unknown tool: ${toolName}`,
          },
        };
    }
  } catch (e) {
    // ForgeError → agent-safe shape (docs/15 §4: category + retryable + message only).
    if (e instanceof ForgeError) {
      return { ok: false, error: e.toAgentSafe() };
    }
    return {
      ok: false,
      error: {
        category: "internal",
        retryable: false,
        message: e instanceof Error ? e.message : "tool call failed",
      },
    };
  }
}

/** Wrap a ForgeError for tool results (used by callers building tool responses). */
export function toolError(
  category: ForgeErrorCategory,
  message: string,
  retryable = false,
): Extract<ToolCallResult, { ok: false }> {
  void newCorrelationId; // correlation handled by the DO's ForgeError; tools surface the agent-safe shape
  return { ok: false, error: { category, retryable, message } };
}
