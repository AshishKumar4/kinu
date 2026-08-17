import { existsSync, lstatSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

/**
 * The Nimbus session worker loads its runtime artifacts — the node shims
 * bundle, esbuild/sqlite wasm, the vite/opencode/opentui payloads — from
 * `env.ASSETS` under `/_assets/*` (digest-pinned per package build). Stage the
 * pinned package's asset tree into the SPA's public dir as a symlink: dev
 * serving and the client build both carry it, and a version bump re-points it
 * here at config load instead of drifting.
 */
const nimbusAssets = join(
  dirname(createRequire(import.meta.url).resolve("@nimbus-sh/worker/package.json")),
  "public/_assets",
);
const staged = resolve(__dirname, "public/_assets");
const stagedLink = lstatSync(staged, { throwIfNoEntry: false });
if (!stagedLink?.isSymbolicLink() || readlinkSync(staged) !== nimbusAssets) {
  rmSync(staged, { recursive: true, force: true });
  symlinkSync(nimbusAssets, staged, "dir");
}
if (!existsSync(staged)) {
  throw new Error(`Nimbus runtime assets missing at ${nimbusAssets} — is @nimbus-sh/worker installed?`);
}

export default defineConfig({
  plugins: [agents(), react(), cloudflare(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
