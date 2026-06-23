import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Forge web Worker build config (docs/09 §3, §5.24).
//
// NOTE on TanStack Start (ADR-0003): the locked framework is TanStack Start, but
// its full SSR-on-CF-Workers scaffold (createStartConfig, server-entry, RSC,
// hydration) is non-trivial and is a focused Phase 1 follow-up from the official
// starter. Phase 0 ships a Vite + React + tRPC-client SPA that satisfies the
// §5.27 criterion (create session → live stream → ready_for_pr) and shares the
// exact tRPC AppRouter types with the control plane. The migration to TanStack
// Start SSR is mechanical (same router + tRPC client; swap the entry/renderer).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 8788,
    // Proxy /api + /ws to the control-plane Worker (fast profile, §4).
    proxy: {
      "/api": "http://localhost:8787",
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
