// Forge web app entry (§5.24–5.26). Mounts the React app with the tRPC + React
// Query providers. Three screens: dashboard shell, new-session form, live-stream.
// Calls the control-plane via fetch (no DO bindings — docs/09 §3).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { trpc, trpcClient } from "./lib/trpc";
import { App } from "./App";

const queryClient = new QueryClient();
// In dev, the Vite proxy forwards /api to the control-plane (localhost:8787);
// in prod, VITE_API_ORIGIN points to the deployed control-plane worker.
const CP_ORIGIN = import.meta.env.VITE_API_ORIGIN ?? ""; // same-origin / proxied

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
  <StrictMode>
    <trpc.Provider client={trpcClient(CP_ORIGIN)} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </trpc.Provider>
  </StrictMode>,
);
