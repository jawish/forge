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
import { ATTR } from "@forge/domain";
import type { Env } from "./env";
import { resolveProfile } from "./env";
import { configureConsoleExporter, startSpan } from "./otel/console";
import { SessionDO } from "./do/session";

// Export the DO class so the wrangler binding resolves it.
export { SessionDO };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

      // --- Seam 1: tRPC API (§5.6) + Seam 4 webhooks (§8) ------------------
      // 404 until §5.6 wires the router; /api/ops/health above is the live route.
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
