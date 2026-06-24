// New-session screen (§5.26 screen 2): repo + prompt form. Calls session.create
// then prompt.submit via the tRPC client (typed by the control-plane AppRouter).

import { useState } from "react";
import { trpc } from "../lib/trpc";

export function NewSessionScreen({ onCreated }: { onCreated: (sessionId: string) => void }) {
  const [repoId, setRepoId] = useState("repo_demo");
  const [branch, setBranch] = useState("forge/web/new-session");
  const [prompt, setPrompt] = useState("fix the typo in the README");

  // prompt.submit — auto-submitted after the session is created so the agent
  // turn actually starts (the prompt drives the model stream → DO transitions).
  const submitPrompt = trpc.prompt.submit.useMutation();

  const create = trpc.session.create.useMutation({
    onSuccess: (data) => {
      // Auto-submit the prompt to kick off the agent turn.
      if (prompt.trim()) {
        submitPrompt.mutate({
          sessionId: data.sessionId,
          userId: "user_web",
          content: prompt,
        });
      }
      onCreated(data.sessionId);
    },
  });

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h2>New session</h2>
      <label>
        Repo
        <input value={repoId} onChange={(e) => setRepoId(e.target.value)} style={input} />
      </label>
      <label>
        Branch
        <input value={branch} onChange={(e) => setBranch(e.target.value)} style={input} />
      </label>
      <label>
        Prompt
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          style={input}
        />
      </label>
      <button
        onClick={() => create.mutate({ repoId, branch, createdByUserId: "user_web" })}
        disabled={create.isPending}
        style={{ padding: "8px 16px", alignSelf: "flex-start" }}
      >
        {create.isPending ? "Starting…" : "Start session"}
      </button>
      {create.error && <p style={{ color: "#c00" }}>Error: {create.error.message}</p>}
      <p style={{ color: "#888", fontSize: 13 }}>
        Submitting creates a queued session + starts the agent; the live-stream view opens next.
      </p>
    </section>
  );
}

const input: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: 8,
  marginTop: 4,
  boxSizing: "border-box",
};
