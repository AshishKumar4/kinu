/** Design gallery config, frontend only (no worker plugin): `bunx vite dev --config gallery.vite.config.ts --port 5199`. */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { wgslVitePlugin } from "@vgpu/wgsl/loader-vite";
import { defineConfig } from "vite";
import { promptText } from "./vite-prompt-text";

const galleryRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [promptText(), wgslVitePlugin(), react(), tailwindcss()],
  // UMD-only, so it has no `default` export when served raw; prebundle it.
  optimizeDeps: {
    include: ["@plannotator/web-highlighter"],
  },
  resolve: {
    alias: {
      "@": resolve(galleryRoot, "src"),
      "node:crypto": resolve(galleryRoot, "client-node-stubs.ts"),
      "node:async_hooks": resolve(galleryRoot, "client-node-stubs.ts"),
      "node:util": resolve(galleryRoot, "client-node-stubs.ts"),
      // Pages open their own agent connection; without these stubs they dial a non-Worker vite server.
      "agents/react": resolve(galleryRoot, "src/gallery-agent-stub.ts"),
      "@cloudflare/ai-chat/react": resolve(galleryRoot, "src/gallery-agent-stub.ts"),
    },
  },
});
