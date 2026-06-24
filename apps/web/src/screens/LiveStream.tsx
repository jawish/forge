// Session live-stream view (§5.26 screen 3). Connects to /ws/:sessionId and
// renders the ServerToClientEvent stream (state snapshot, thinking delta, tool
// call, status transition). Thin typed React on the Client SDK event stream
// (ADR-0004). Drives a prompt submit + observes the session reach ready_for_pr.

import { useEffect, useRef, useState } from "react";
import type { ServerToClientEvent } from "@forge/domain";
import { trpc } from "../lib/trpc";

export function SessionLiveScreen({
  sessionId,
  onBack,
}: {
  sessionId: string;
  onBack: () => void;
}) {
  const [status, setStatus] = useState<string>("connecting");
  const [activity, setActivity] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const wsRef = useRef<WebSocket | null>(null);

  const submitPrompt = trpc.prompt.submit.useMutation();

  // Open the WS and consume the typed event stream (docs/10 §4).
  useEffect(() => {
    const wsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/${sessionId}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data) as ServerToClientEvent;
        onEvent(event);
      } catch {
        // ignore malformed
      }
    };
    ws.onopen = () => setLog((l) => [...l, "[ws] connected"]);
    ws.onclose = () => setLog((l) => [...l, "[ws] closed"]);
    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  function onEvent(event: ServerToClientEvent) {
    switch (event.type) {
      case "state_snapshot":
        setStatus(event.status);
        setActivity(event.activity);
        setLog((l) => [
          ...l,
          `[snapshot] status=${event.status} activity=${event.activity ?? "-"}`,
        ]);
        break;
      case "thinking_delta":
        setLog((l) => [...l, `[thinking] ${event.delta}`]);
        break;
      case "tool_call":
        setLog((l) => [...l, `[tool] ${event.toolCall.toolName}`]);
        break;
      case "status_transition":
        setStatus(event.to.status);
        setLog((l) => [...l, `[transition] → ${event.to.status} (${event.reason})`]);
        break;
      default:
        break;
    }
  }

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>Session</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <a
            href={`/code/${sessionId}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              padding: "4px 12px",
              border: "1px solid #ccc",
              borderRadius: 6,
              textDecoration: "none",
              color: "#2563eb",
              fontSize: 14,
            }}
            title="Open code-server (VS Code) in the sandbox"
          >
            📝 code-server
          </a>
          <button onClick={onBack}>← Back</button>
        </div>
      </div>
      <code style={{ color: "#888" }}>{sessionId}</code>
      <div style={{ display: "flex", gap: 16 }}>
        <span>
          status: <strong data-testid="status">{status}</strong>
        </span>
        <span>
          activity: <strong>{activity ?? "-"}</strong>
        </span>
      </div>

      <div
        style={{
          border: "1px solid #ddd",
          borderRadius: 6,
          padding: 12,
          height: 320,
          overflow: "auto",
          fontFamily: "monospace",
          fontSize: 13,
          background: "#fafafa",
        }}
      >
        {log.length === 0 ? <span style={{ color: "#aaa" }}>connecting…</span> : null}
        {log.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!prompt.trim()) return;
          submitPrompt.mutate({ sessionId, userId: "user_web", content: prompt });
          setLog((l) => [...l, `[you] ${prompt}`]);
          setPrompt("");
        }}
        style={{ display: "flex", gap: 8 }}
      >
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Send a prompt…"
          style={{ flex: 1, padding: 8 }}
        />
        <button type="submit" disabled={submitPrompt.isPending}>
          Send
        </button>
      </form>
    </section>
  );
}
