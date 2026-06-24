// Forge control-plane Worker entry (docs/09 §3, docs/10 §6).
// Routes:
//   /api/ops/health   — liveness + readiness (seam 6, docs/10 §7)
//   /ws/:sessionId    — WS gateway → SessionDO (seam 3 — §5.11)
//   /api/*            — tRPC v11 (seam 1 — §5.6)
//   /slack/events     — Slack Bolt (seam 4 — §8.1)
//   /github/webhooks  — GitHub App webhooks (seam 4 — §8.3)
//   /internal/queue/* — Queue consumers (§8)
//
// §4 wires /api/ops/health + the OTel console exporter so `mise dev` boots and
// spans print (checklist §4.7). The other routes land in §5/§8.

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

// Export the DO class so the wrangler binding resolves it.
export { SessionDO };

export default {
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
      // --- CORS preflight (cross-origin web app → worker) -------------------
      // The web app (forge-web-dev.pages.dev) and the control-plane worker are
      // on different origins in the deployed dev environment. The browser sends
      // an OPTIONS preflight before any cross-origin POST/GET with content-type
      // JSON. Short-circuit with 204 + CORS headers.
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }

      // --- Seam 6: ops/debugging (docs/10 §7) ------------------------------
      if (url.pathname === "/api/ops/health") {
        // Health reports profile + provider names without instantiating the
        // sandbox (which uses node:child_process, only loadable in local workerd).
        span.setAttribute("http.status", 200);
        return jsonResponse({
          status: "ok",
          profile,
          model: profile === "fast" ? "mock" : "ai-gateway",
          sandbox: profile === "fast" ? "local" : "cloudflare",
          ts: Date.now(),
        });
      }

      // /api/ops/init-db — apply the D1 session-projection migration (docs/12 §3).
      // Used by local dev + tests (miniflare doesn't auto-apply D1 migrations).
      // In production, `wrangler d1 migrations apply` handles this at deploy.
      if (url.pathname === "/api/ops/init-db") {
        await applyD1Migration(env.DB);
        span.setAttribute("http.status", 200);
        return jsonResponse({ status: "ok", migrated: "session" });
      }

      // --- Seam 3: WS gateway → SessionDO (§5.11) --------------------------
      // The public route is /ws/:sessionId (docs/10 §4). The Agents SDK
      // routeAgentRequest expects /{prefix}/{namespace}/{name}, so we rewrite
      // /ws/:sessionId → /ws/SESSION_DO/:sessionId with prefix='ws'.
      if (url.pathname.startsWith("/ws/") && request.headers.get("upgrade") === "websocket") {
        const sessionId = url.pathname.split("/")[2];
        if (sessionId) {
          const rewritten = new Request(new URL(`/ws/SESSION_DO/${sessionId}`, url), request);
          const wsResponse = await routeAgentRequest(rewritten, env, { prefix: "ws" });
          if (wsResponse) {
            span.setAttribute("http.status", 101);
            span.setAttribute(ATTR.SESSION_ID, sessionId);
            return wsResponse;
          }
        }
      }

      // --- Seam 5: platform MCP tools (docs/10 §6, §5.15) ------------------
      // /api/mcp/tools  — list the 4 platform-provided MCP tools.
      // /api/mcp/call   — call a tool against a session's DO (agent-facing).
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

      // --- Seam 4: GitHub webhooks (docs/11 §4, checklist §8.3) ------------
      // /github/webhooks: PR merged/closed → terminal transitions on the
      // matching session (matched by the forge/<user>/<shortid>-<slug> branch).
      if (url.pathname === "/github/webhooks" && request.method === "POST") {
        const body = (await request.json()) as {
          action?: string;
          pull_request?: {
            number?: number;
            html_url?: string;
            merged?: boolean;
            head?: { ref?: string };
          };
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
            // Match the session by its shortid prefix; transition to terminal.
            // (Session name lookup via D1 index is §8 widening; here we transition
            // any session whose name starts with the shortid.)
            const sessionId = `sess_${shortid}`;
            const idObj = env.SESSION_DO.idFromName(sessionId);
            const stub = env.SESSION_DO.get(idObj) as unknown as {
              transitionTo(to: { status: "merged" | "closed" }, reason: string): Promise<unknown>;
            };
            await stub.transitionTo({ status: transition.status }, transition.reason).catch(() => {
              // No matching session / already terminal — ack the webhook anyway.
            });
          }
        }
        span.setAttribute("http.status", 200);
        return jsonResponse({ ok: true });
      }

      // --- Seam 4: Slack Events API (docs/19 Part A, §8.1) -----------------
      // /slack/events: verify signing secret → classify → act (spawn/post/dedup).
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
        // url_verification needs the challenge echoed back; other results are acks.
        if (result.kind === "url_verification") {
          return jsonResponse({ challenge: result.challenge });
        }
        return jsonResponse({ ok: true, result: result.kind });
      }

      // --- Seam 1: tRPC API (§5.6) ------------------------------------------
      // /api/* (except /api/ops/* which is seam 6 above) routes to tRPC v11.
      if (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/ops/")) {
        span.setAttribute("http.status", 200);
        const trpcResponse = await fetchRequestHandler({
          endpoint: "/api",
          req: request,
          router: appRouter,
          createContext: (opts) => createContext({ req: opts.req, env, executionCtx: ctx }),
        });
        // Attach CORS headers to the tRPC response so cross-origin web requests work.
        return addCorsHeaders(trpcResponse);
      }

      // --- code-server deep-link (§8.2) ------------------------------------
      // /code/:sessionId redirects to the code-server embed running in the
      // sandbox. The deep-link format is documented in code-server/config.ts.
      // In the fast profile (no sandbox), returns a placeholder explaining the
      // embed needs a running sandbox. In the real profile, this would proxy
      // to the sandbox's code-server port (3000) via the Container DO.
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
          // Real profile: proxy to the sandbox DO's code-server port.
          // The sandbox DO exposes the code-server instance on port 3000;
          // a full proxy would forward the request + WS upgrades. For now,
          // return the deep-link + a redirect to the sandbox's port.
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
} satisfies ExportedHandler<Env>;

/** CORS headers for cross-origin web app access (web on Pages, API on Workers). */
function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,trpc-accept,content-type,trpc-batch-mode",
  };
}

/** Attach CORS headers to an existing Response (clone + add headers). */
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
