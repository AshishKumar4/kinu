/**
 * Standalone Vite config for the design gallery (gallery.html) — frontend
 * only, no Cloudflare worker plugin, so the component gallery renders without
 * auth or bindings. Used by the design-system audit harness:
 *
 *   bunx vite dev --config gallery.vite.config.ts --port 5199
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const galleryRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(galleryRoot, "src"),
      "node:crypto": resolve(galleryRoot, "client-node-stubs.ts"),
      "node:async_hooks": resolve(galleryRoot, "client-node-stubs.ts"),
      // The agent transport. A frame that mounts a PAGE rather than a surface
      // gets no `Rpc` prop — the page opens its own connection — so without
      // these two the page opened a WebSocket to a vite server that is not a
      // Worker and drew nothing. Three fork frames did exactly that.
      "agents/react": resolve(galleryRoot, "src/gallery-agent-stub.ts"),
      "@cloudflare/ai-chat/react": resolve(galleryRoot, "src/gallery-agent-stub.ts"),
    },
  },
});
