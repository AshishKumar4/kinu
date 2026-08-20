/**
 * Standalone Vite config for the design gallery (gallery.html) — frontend
 * only, no Cloudflare worker plugin, so the component gallery renders without
 * auth or bindings. Used by the design-system audit harness:
 *
 *   bunx vite dev --config gallery.vite.config.ts --port 5199
 */
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "node:crypto": resolve(__dirname, "gallery-node-stubs.ts"),
      // The agent transport. A frame that mounts a PAGE rather than a surface
      // gets no `Rpc` prop — the page opens its own connection — so without
      // these two the page opened a WebSocket to a vite server that is not a
      // Worker and drew nothing. Three fork frames did exactly that.
      "agents/react": resolve(__dirname, "src/gallery-agent-stub.ts"),
      "@cloudflare/ai-chat/react": resolve(__dirname, "src/gallery-agent-stub.ts"),
    },
  },
});
