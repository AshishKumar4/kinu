import { existsSync, lstatSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { wgslVitePlugin } from "@vgpu/wgsl/loader-vite";
import { defineConfig } from "vite";
import { promptText } from './vite-prompt-text';
import { slateVendor } from './slate-vendor';
import { DEV_PREVIEW_SUFFIX, devPreviewPort, devPreviewTlsDir, devPreviewZone } from './vite-preview-zone';

/** Nimbus loads its runtime artifacts from `env.ASSETS` `/_assets/*`; symlink the pinned package's tree
 *  into `public/` so dev and build carry it and a version bump re-points it. */
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

/** Dev serves the core barrel as source, so a node builtin breaks the browser at module init; stub
 *  them for the client environment only (the worker keeps real builtins for nimbus-route). */
const clientNodeStubs = resolve(__dirname, "client-node-stubs.ts");

const stubClientNodeBuiltins = {
  name: "kinu:stub-client-node-builtins",
  enforce: "pre" as const,
  resolveId(this: { environment?: { name: string } }, source: string): string | null {
    if (this.environment !== undefined && this.environment.name !== "client") return null;

    if (
      source === "node:crypto" ||
      source === "node:async_hooks" ||
      source === "node:util"
    )
      return clientNodeStubs;

    return null;
  },
};

/**
 * Worker-only source maps: wrangler's `no_bundle` deploy reads each module's `sourceMappingURL` for
 * `upload_source_maps`. Selected as not-`client` so a worker rename cannot drop them; the client is
 * excluded so TypeScript is not served publicly.
 */
const workerSourceMaps = {
  name: "kinu:worker-source-maps",
  configEnvironment(name: string) {
    if (name === "client") return null;

    return { build: { sourcemap: true } };
  },
};

/** vgpu's WGSL loader, scoped to the client environment; the Worker build never sees a shader. */
const wgslClientOnly = {
  ...wgslVitePlugin(),
  name: "kinu:wgsl-client",
  applyToEnvironment(environment: { name: string }): boolean {
    return environment.name === "client";
  },
};

/**
 * Dev persistence directory for DOs, KV and R2. The shared default `.wrangler/state` keeps pre-migration
 * tables (no column reconcile), failing routes with `no such column`. Measured 2026-09-18 on
 * @cloudflare/vite-plugin 1.53.1: `persistState.path` resolves against the vite root and appends `v3`.
 */
const devStateDir = process.env.KINU_DEV_STATE_DIR;

const previewPort = devPreviewPort(__dirname);

export default defineConfig(({ command }) => ({
  // The dependency optimizer's cache, one per checkout and kept between boots, so a warm boot re-optimizes
  // nothing and a page's module graph is never re-bundled under it. Vite's default, `node_modules/.vite`, is the
  // primary checkout's in every worktree (setup-worktree.sh), so two dev servers on different lockfiles
  // re-optimized into one directory and deleted each other's deps: "The file does not exist at
  // .../.vite/deps_kinu/..." (2026-09-23). The harness names a directory of its own (`KINU_DEV_CACHE_DIR`), so a
  // developer's `bun run dev` beside a gate's boot never shares one; the ladder boots one harness dev server per
  // checkout at a time (SHARED_RESOURCES in scripts/ladder.ts).
  cacheDir: process.env.KINU_DEV_CACHE_DIR ?? '.vite',
  plugins: [
    promptText(), slateVendor(), stubClientNodeBuiltins, workerSourceMaps, wgslClientOnly, agents(), react(),
    cloudflare({
      persistState: devStateDir === undefined ? true : { path: devStateDir },
      // A harness boot opens no Workers inspector. The plugin's default takes 9229, or the next port it finds free
      // before it binds, so two boots at once both take 9229 and one dies with EADDRINUSE (2026-09-24).
      inspectorPort: process.env.KINU_DEV_INSPECTOR === "off" ? false : undefined,
      // `vite dev` serves its own preview zone (vite-preview-zone.ts); a build keeps the deployed zone. A harness
      // boot binds the Drive's JWT_SECRET here, as a var: wrangler reads secrets from packages/cf-backend/.dev.vars
      // alone when the checkout has one, and a .dev.vars JWT_SECRET still overrides this.
      config: command === "serve"
        ? (worker) => {
          const vars = { ...worker.vars, PREVIEW_HOST_SUFFIX: DEV_PREVIEW_SUFFIX, PREVIEW_HOST_PORT: String(previewPort) };
          const jwtSecret = process.env.KINU_DEV_JWT_SECRET;

          return { vars: jwtSecret === undefined ? vars : { ...vars, JWT_SECRET: jwtSecret } };
        }
        : undefined,
    }),
    devPreviewZone(devPreviewTlsDir(__dirname), previewPort),
    tailwindcss(),
  ],
  // The zone's requests reach vite with their preview host.
  server: { allowedHosts: [`.${DEV_PREVIEW_SUFFIX}`] },
  // The fabric outbox imports a stubbed builtin, so it is served as source; the UMD-only highlighter
  // has no `default` export as source, so it is prebundled.
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
}));
