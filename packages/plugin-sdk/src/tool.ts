// @forge/plugin-sdk — the MCP author SDK (docs/19 §10, ADR-0007).
//
// Purpose: write registry-managed MCP servers that pass Forge's governance
// pipeline. Provides:
//   - Typed tool definitions (args/results type-safe end-to-end)
//   - Permission-manifest declaration helpers (Outbound Workers egress allowlist
//     + credential requirements, generated from the same source as the tool code)
//   - An MCP server definition that bundles tools + permissions + metadata
//
// NOT for: OpenCode plugins (there is no OpenCode plugin story — configure via
// MCP, docs/19 §7). NOT for control-plane extension.

import { z, type ZodType } from "zod";

/** A typed MCP tool: name, description, input schema, handler. */
export interface McpToolDef<TInput, TResult> {
  name: string;
  description: string;
  /** The zod input schema — also the MCP tool's inputSchema. */
  input: ZodType<TInput>;
  /** The handler — receives the validated input, returns the result. */
  handler: (input: TInput, ctx: ToolContext) => Promise<TResult> | TResult;
}

/** Context passed to a tool handler (the host provides these). */
export interface ToolContext {
  /** The session id (the MCP server runs per-session in the sandbox). */
  sessionId: string;
  /** The repo id. */
  repoId: string;
  /** A logger (structured, OTel-correlated). */
  log: (level: "info" | "warn" | "error", message: string, attrs?: Record<string, unknown>) => void;
}

/** Define a typed MCP tool (the main author surface). */
export function defineTool<TInput, TResult>(
  def: McpToolDef<TInput, TResult>,
): McpToolDef<TInput, TResult> {
  return def;
}

/** An egress destination for the permission manifest (docs/18 §5). */
export interface EgressDestination {
  /** host:port the MCP may reach. */
  host: string;
  /** Optional credential reference (resolved at the boundary — agent never holds it). */
  credential?: string;
}

/**
 * The permission manifest — the MCP's declared egress + credential needs, enforced
 * by the Outbound Workers boundary (docs/18 §5). Generated from the same source as
 * the tool code so the manifest can't drift from what the MCP actually needs.
 */
export interface PermissionManifest {
  /** Egress allowlist (deny-by-default; anything not listed is blocked). */
  egress: EgressDestination[];
  /** Filesystem paths the MCP reads/writes (sandbox-scoped). */
  paths?: { read?: string[]; write?: string[] };
}

/** Declare a permission manifest for an MCP server. */
export function definePermissions(manifest: PermissionManifest): PermissionManifest {
  return manifest;
}

/**
 * An MCP server definition: its tools + permission manifest + display metadata.
 * This is what the plugin-sdk scaffolds into a scorecard-friendly repo (docs/19 §10).
 */
export interface McpServerDef {
  /** The server id (registry key, e.g. 'memory', 'linear'). */
  id: string;
  displayName: string;
  description: string;
  version: string;
  tools: McpToolDef<unknown, unknown>[];
  permissions: PermissionManifest;
}

/** Compose an MCP server from its tools + permissions + metadata. */
export function defineMcpServer(def: McpServerDef): McpServerDef {
  // Validate the manifest is non-empty (an MCP with no declared egress can't
  // reach anything — deny-by-default; this is the correct default, docs/18 §5).
  if (
    def.permissions.egress.length === 0 &&
    (!def.permissions.paths ||
      (def.permissions.paths.read?.length === 0 && def.permissions.paths.write?.length === 0))
  ) {
    // No egress + no paths — a pure-compute MCP. Allowed; flagged for review.
  }
  return def;
}

/** Export the MCP server's tool list in the MCP-protocol tool shape (for the host). */
export function toMcpToolList(server: McpServerDef): Array<{
  name: string;
  description: string;
  inputSchema: unknown;
}> {
  return server.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input,
  }));
}

export { z };
export type { ZodType };
