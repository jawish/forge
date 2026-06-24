// @forge/plugin-sdk — the MCP author SDK (docs/19 §10, ADR-0007).
// For writing registry-managed MCP servers that pass Forge's governance pipeline:
// typed tool definitions + permission-manifest helpers + MCP server composition.

export { defineTool, definePermissions, defineMcpServer, toMcpToolList, z } from "./tool";
export type {
  McpToolDef,
  ToolContext,
  EgressDestination,
  PermissionManifest,
  McpServerDef,
  ZodType,
} from "./tool";
