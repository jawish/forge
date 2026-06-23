// Forge web app shell (§5.26). The session list is the landing view (docs/07
// §4.4 — dashboard); new-session opens the composer; a live stream opens on
// row click. The session live-stream view connects to /ws/:sessionId.

import { useState } from "react";
import { SessionListScreen } from "./screens/SessionList";
import { NewSessionScreen } from "./screens/NewSession";
import { SessionLiveScreen } from "./screens/LiveStream";

type View = { name: "list" } | { name: "new" } | { name: "session"; sessionId: string };

export function App() {
  const [view, setView] = useState<View>({ name: "list" });

  return (
    <div
      style={{ fontFamily: "system-ui, sans-serif", maxWidth: 900, margin: "0 auto", padding: 24 }}
    >
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>Forge</h1>
        <p style={{ color: "#666", margin: "4px 0 0" }}>
          Internal agentic software-factory platform
        </p>
      </header>

      {view.name === "list" ? (
        <SessionListScreen
          onOpenSession={(sessionId) => setView({ name: "session", sessionId })}
          onNewSession={() => setView({ name: "new" })}
        />
      ) : view.name === "new" ? (
        <NewSessionScreen onCreated={(sessionId) => setView({ name: "session", sessionId })} />
      ) : (
        <SessionLiveScreen sessionId={view.sessionId} onBack={() => setView({ name: "list" })} />
      )}
    </div>
  );
}
