// MCP JSON-RPC server for forge.* tools (docs/19 §7, ADR-0007).
// Implements the Model Context Protocol so OpenCode (or any MCP client) can
// discover and call the platform tools:
//   - forge.reportStatus   — update session status/activity
//   - forge.completePR     — signal the agent is done (triggers verification + PR)
//   - forge.requestHumanInput — ask the human a question
//   - forge.createArtifact — record an artifact (diff, test result, screenshot)
//
// Transport: HTTP POST with JSON-RPC 2.0 over the request/response body.
// The client (OpenCode inside the sandbox) POSTs JSON-RPC messages to /api/mcp.

import { ATTR } from "@forge/domain";
import type { Env } from "../env";
import { startSpan } from "../otel/console";
import { callTool, FORGE_MCP_TOOLS } from "./tools";

/** JSON-RPC 2.0 request shape. */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 response shape. */
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** MCP tool definition (matches the MCP spec tools/list response). */
interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Convert the forge tool definitions to MCP format. */
function getMcpTools(): McpTool[] {
  return FORGE_MCP_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/** MCP error codes (from the MCP spec). */
const MCP_ERRORS = {
  PARSE_ERROR: -32700,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

/**
 * Handle a single MCP JSON-RPC request. Returns the JSON-RPC response.
 * The sessionId is extracted from the request params (each tool call includes it).
 */
export async function handleMcpRequest(body: JsonRpcRequest, env: Env): Promise<JsonRpcResponse> {
  const span = startSpan("mcp.request", {
    [ATTR.SESSION_ID]: "n/a",
    "mcp.method": body.method,
  });

  try {
    switch (body.method) {
      case "initialize": {
        return {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "forge-mcp", version: "1.0.0" },
          },
        };
      }

      case "tools/list": {
        return {
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: getMcpTools() },
        };
      }

      case "tools/call": {
        const params = body.params as {
          name: string;
          arguments?: Record<string, unknown>;
        };
        if (!params?.name) {
          return {
            jsonrpc: "2.0",
            id: body.id,
            error: {
              code: MCP_ERRORS.INVALID_PARAMS,
              message: "missing tool name",
            },
          };
        }

        // The sessionId must be passed in the arguments (OpenCode includes
        // it as part of the tool call context).
        const sessionId = (params.arguments?.sessionId as string) ?? "";
        if (!sessionId) {
          return {
            jsonrpc: "2.0",
            id: body.id,
            error: {
              code: MCP_ERRORS.INVALID_PARAMS,
              message: "missing sessionId in arguments",
            },
          };
        }

        span.setAttribute(ATTR.SESSION_ID, sessionId);
        span.setAttribute("mcp.tool", params.name);

        const result = await callTool(params.name, params.arguments ?? {}, sessionId, env);

        if (result.ok) {
          return {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result.data),
                },
              ],
            },
          };
        }
        return {
          jsonrpc: "2.0",
          id: body.id,
          error: {
            code: MCP_ERRORS.INTERNAL,
            message: result.error.message,
            data: result.error,
          },
        };
      }

      case "notifications/initialized": {
        // Notification — no response needed, but we return one for HTTP.
        return { jsonrpc: "2.0", id: body.id, result: {} };
      }

      default: {
        return {
          jsonrpc: "2.0",
          id: body.id,
          error: {
            code: MCP_ERRORS.METHOD_NOT_FOUND,
            message: `method not found: ${body.method}`,
          },
        };
      }
    }
  } catch (err) {
    span.recordError("mcp_error", undefined, err instanceof Error ? err.message : String(err));
    return {
      jsonrpc: "2.0",
      id: body.id,
      error: {
        code: MCP_ERRORS.INTERNAL,
        message: err instanceof Error ? err.message : String(err),
      },
    };
  } finally {
    span.end();
  }
}

/**
 * Handle a batch of MCP requests (JSON-RPC supports batched calls).
 * Each element is a separate JSON-RPC request.
 */
export async function handleMcpBatch(
  body: JsonRpcRequest | JsonRpcRequest[],
  env: Env,
): Promise<JsonRpcResponse | JsonRpcResponse[]> {
  if (Array.isArray(body)) {
    return Promise.all(body.map((req) => handleMcpRequest(req, env)));
  }
  return handleMcpRequest(body, env);
}
