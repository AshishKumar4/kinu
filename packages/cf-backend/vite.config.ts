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

/**
 * The client graph reaches node builtins through `@kinu.run/core` imports:
 * dev serves the barrel as source, so every module it re-exports loads in the
 * browser and an externalized `node:crypto` throws at module init, blanking
 * the app before React mounts. The production build tree-shakes these away.
 * Resolve them to stubs for the CLIENT environment only — the worker keeps
 * real node builtins (nimbus-route hashes with them).
 */
const clientNodeStubs = resolve(__dirname, "client-node-stubs.ts");

const stubClientNodeBuiltins = {
  name: "kinu:stub-client-node-builtins",
  enforce: "pre" as const,
  // The worker environment keeps real node builtins (nimbus-route hashes
  // with them); only the browser graph gets stubs.
  resolveId(this: { environment?: { name: string } }, source: string): string | null {
    if (this.environment !== undefined && this.environment.name !== "client") return null;
    if (source === "node:crypto" || source === "node:async_hooks") return clientNodeStubs;
    return null;
  },
};

/**
 * Source maps for the WORKER build only.
 *
 * `upload_source_maps` in wrangler.jsonc is what makes Cloudflare remap a
 * production stack trace, and the maps it uploads are the ones on disk: the
 * deploy runs through this plugin's generated config, which sets `no_bundle`, so
 * wrangler bundles nothing of its own and reads each module's
 * `sourceMappingURL`. Without this hook there is no map to read and the flag is
 * a silent no-op.
 *
 * The environment is named per worker (`kinu`, `kinu_staging` under
 * `CLOUDFLARE_ENV=staging`), so it is selected the way the stub plugin above
 * selects it — everything that is not `client`. Naming the worker environments
 * instead would leave staging without maps the day the name changes.
 *
 * The client is deliberately excluded: its output is published static assets, so
 * a map there is original TypeScript served from the public origin.
 */
const workerSourceMaps = {
  name: "kinu:worker-source-maps",
  configEnvironment(name: string) {
    if (name === "client") return null;
    return { build: { sourcemap: true } };
  },
};

export default defineConfig({
  plugins: [stubClientNodeBuiltins, workerSourceMaps, agents(), react(), cloudflare(), tailwindcss()],
  // The fabric outbox is the one pre-bundled dep that imports a stubbed
  // builtin; excluded, it serves as source and the resolveId hook reaches it.
  // @plannotator/web-highlighter is the inverse: UMD-only (its `module` field
  // names the same min.js), so served as source it has no `default` export
  // and the plan surface dies in dev. Prebundled, interop applies.
  optimizeDeps: {
    exclude: ["@nimbus-sh/fabric/outbox.js"],
    include: ["@plannotator/web-highlighter"],
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  environments: {
    client: {
      build: {
        rolldownOptions: {
          input: {
            app: resolve(__dirname, "index.html"),
            landing: resolve(__dirname, "landing.html"),
          },
        },
      },
    },
  },
});
