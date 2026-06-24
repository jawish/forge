// The worker fetch handler — extracted from index.ts so the test entry point
// can import it without pulling in the Sandbox DO class export.
// index.ts re-exports this as its default export + adds the Sandbox export.

import { routeAgentRequest } from "@cloudflare/agents";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { ATTR } from "@forge/domain";
import type { Env } from "./env";
import { resolveProfile } from "./env";
import { configureConsoleExporter, startSpan } from "./otel/console";
import { SessionDO } from "./do/session";
import { applyD1Migration } from "./do/d1-schema";
import { createContext } from "./api/context";
import { appRouter } from "./api/router";
import { FORGE_MCP_TOOLS, callTool } from "./mcp/tools";
import { handleSlackEvent } from "./slack/handler";
import { SLACK_SIGNATURE_HEADER, SLACK_TIMESTAMP_HEADER } from "./slack/verify";
import { buildSlackPorts } from "./slack/ports";
import { sessionIdFromBranch, webhookToTransition } from "./git/pr";

export { SessionDO };

/** CORS headers for cross-origin web app access. */
function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,trpc-accept,content-type,trpc-batch-mode",
  };
}

/** Attach CORS headers to an existing Response. */
function addCorsHeaders(res: Response): Response {
  const newRes = new Response(res.body, res);
  for (const [k, v] of Object.entries(corsHeaders())) {
    newRes.headers.set(k, v);
  }
  return newRes;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}

/** The worker fetch handler. Exported so index.ts + test-entry.ts can both use it. */
export function createFetchHandler() {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const profile = resolveProfile(env);
      configureConsoleExporter({ enabled: true });

      const url = new URL(request.url);
      const span = startSpan(`http.${request.method.toLowerCase()}`, {
        [ATTR.SESSION_ID]: "n/a",
        "http.method": request.method,
        "http.path": url.pathname,
        "forge.profile": profile,
      });

      try {
        if (request.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders() });
        }

        if (url.pathname === "/api/ops/health") {
          span.setAttribute("http.status", 200);
          return jsonResponse({
            status: "ok",
            profile,
            model: profile === "fast" ? "mock" : "ai-gateway",
            sandbox: profile === "fast" ? "local" : "cloudflare",
            ts: Date.now(),
          });
        }

        if (url.pathname === "/api/ops/init-db") {
          await applyD1Migration(env.DB);
          span.setAttribute("http.status", 200);
          return jsonResponse({ status: "ok", migrated: "session" });
        }

        if (url.pathname.startsWith("/ws/")) {
          const sessionId = url.pathname.split("/")[2];
          if (sessionId) {
            const rewritten = new Request(new URL(`/ws/session-do/${sessionId}`, url), request);
            try {
              const wsResponse = await routeAgentRequest(rewritten, env, { prefix: "ws" });
              if (wsResponse) {
                span.setAttribute("http.status", wsResponse.status);
                span.setAttribute(ATTR.SESSION_ID, sessionId);
                return wsResponse;
              }
            } catch (wsErr) {
              console.error("[ws] routeAgentRequest failed:", wsErr instanceof Error ? wsErr.message : String(wsErr));
              span.setAttribute("http.status", 500);
              return jsonResponse(
                { error: "ws_failed", message: wsErr instanceof Error ? wsErr.message : String(wsErr) },
                500,
              );
            }
          }
        }

        if (url.pathname === "/api/mcp" && request.method === "POST") {
          const { handleMcpBatch } = await import("./mcp/server");
          const body = (await request.json()) as Parameters<typeof handleMcpBatch>[0];
          const result = await handleMcpBatch(body, env);
          span.setAttribute("http.status", 200);
          return jsonResponse(result);
        }
        if (url.pathname === "/api/mcp" && request.method === "GET") {
          span.setAttribute("http.status", 200);
          return jsonResponse({
            jsonrpc: "2.0",
            info: { name: "forge-mcp", version: "1.0.0" },
            endpoint: "/api/mcp",
            methods: ["initialize", "tools/list", "tools/call"],
          });
        }

        if (url.pathname === "/api/mcp/tools") {
          span.setAttribute("http.status", 200);
          return jsonResponse({ tools: FORGE_MCP_TOOLS });
        }
        if (url.pathname === "/api/mcp/call" && request.method === "POST") {
          const body = (await request.json()) as {
            tool: string;
            args: Record<string, unknown>;
            sessionId: string;
          };
          const result = await callTool(body.tool, body.args, body.sessionId, env);
          span.setAttribute("http.status", result.ok ? 200 : 500);
          return jsonResponse(result, result.ok ? 200 : 500);
        }

        if (url.pathname === "/github/webhooks" && request.method === "POST") {
          const body = (await request.json()) as {
            action?: string;
            pull_request?: { number?: number; html_url?: string; merged?: boolean; head?: { ref?: string } };
          };
          const ref = body.pull_request?.head?.ref;
          const shortid = ref ? sessionIdFromBranch(ref) : null;
          if (body.action === "closed" && shortid) {
            const transition = webhookToTransition({
              action: body.action as "closed",
              pull_request: {
                number: body.pull_request?.number ?? 0,
                html_url: body.pull_request?.html_url ?? "",
                merged: body.pull_request?.merged ?? false,
                head_ref: ref ?? "",
              },
            });
            if (transition.status) {
              const sessionId = `sess_${shortid}`;
              const idObj = env.sessionDo.idFromName(sessionId);
              const stub = env.sessionDo.get(idObj) as unknown as {
                transitionTo(to: { status: "merged" | "closed" }, reason: string): Promise<unknown>;
              };
              await stub.transitionTo({ status: transition.status }, transition.reason).catch(() => {});
            }
          }
          span.setAttribute("http.status", 200);
          return jsonResponse({ ok: true });
        }

        if (url.pathname === "/slack/events" && request.method === "POST") {
          const rawBody = await request.text();
          const signingSecret = (env.SLACK_SIGNING_SECRET as string | undefined) ?? "";
          const result = await handleSlackEvent({
            config: { signingSecret },
            ports: buildSlackPorts(env),
            signature: request.headers.get(SLACK_SIGNATURE_HEADER),
            timestamp: request.headers.get(SLACK_TIMESTAMP_HEADER),
            rawBody,
          });
          span.setAttribute("http.status", 200);
          if (result.kind === "url_verification") {
            return jsonResponse({ challenge: result.challenge });
          }
          return jsonResponse({ ok: true, result: result.kind });
        }

        if (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/ops/")) {
          span.setAttribute("http.status", 200);
          const trpcResponse = await fetchRequestHandler({
            endpoint: "/api",
            req: request,
            router: appRouter,
            createContext: (opts) => createContext({ req: opts.req, env, executionCtx: ctx }),
          });
          return addCorsHeaders(trpcResponse);
        }

        if (url.pathname.startsWith("/code/")) {
          const sessionId = url.pathname.split("/")[2];
          if (sessionId) {
            span.setAttribute(ATTR.SESSION_ID, sessionId);
            span.setAttribute("http.status", 200);
            if (profile === "fast") {
              return jsonResponse({
                sessionId,
                message: "code-server embed requires a running sandbox (real profile).",
                deepLink: `/code/${sessionId}`,
              });
            }
            return Response.redirect(`${url.origin}/code/${sessionId}`, 302);
          }
        }

        span.setAttribute("http.status", 404);
        return jsonResponse({ error: "not_found", path: url.pathname }, 404);
      } catch (err) {
        span.setAttribute("http.status", 500);
        span.recordError("internal", undefined, err instanceof Error ? err.message : String(err));
        return jsonResponse({ error: "internal", correlationId: "n/a" }, 500);
      } finally {
        span.end();
      }
    },
  };
}
