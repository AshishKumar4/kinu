/**
 * The workerd layer: only tests whose assertion is about the platform (DO gates, shutdown, facet
 * storage, DO SQLite features); our code stays in `bun test`. `include`, `bunfig.toml`
 * `pathIgnorePatterns` and `scripts/ladder.test.ts` keep the two sets disjoint and non-empty.
 * Compat date/flags match `wrangler.jsonc:6,10`. `tests/workerd` is its own tsc project (its
 * `env.d.ts` would merge into production `Env`); tsconfigs carry no comments (`JSON.parse` readers).
 */
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { buildSync, transform, type OutputFile } from 'esbuild';
import { buildSlateVendor, slateVendor } from './slate-vendor';
import { defineConfig, type Plugin } from 'vitest/config';
import { probeOutbound } from './tests/workerd/http-model-fake';
import { hireOutbound } from './tests/workerd/hire-model-fake';
import { registryOutbound } from './tests/workerd/npm-registry-fake';
import {
  DEPLOY_FAKE_CHANNEL, DEPLOY_FAKE_CLIENT_ID, DEPLOY_FAKE_RECORD, DEPLOY_FAKE_REFRESH_TOKEN,
  assetsOutbound, deployOutbound,
} from './tests/workerd/deploy-fake';
import { kCurrentWorker, type V4ModuleDefinition } from 'miniflare';
import { builtinModules } from 'node:module';
import { promptText } from './vite-prompt-text';

/**
 * KINU-065: Vite's oxc supports only legacy decorators, which break `@callable()` (they register the
 * prototype, not the method). Decorated modules are transformed with esbuild, as `wrangler deploy` does.
 */
const DECORATED_SOURCE = /^\s*@[A-Za-z_$][\w$]*\s*\(/mu;

function standardDecorators(): Plugin {
  return {
    name: 'kinu:standard-decorators',
    enforce: 'pre',
    async transform(code, id) {
      const path = id.split('?')[0];

      if (!/\.tsx?$/u.test(path) || path.includes('/node_modules/')) return null;

      if (!DECORATED_SOURCE.test(code)) return null;

      const result = await transform(code, {
        loader: path.endsWith('.tsx') ? 'tsx' : 'ts',
        target: 'es2022',
        jsx: 'automatic',
        sourcefile: path,
        sourcemap: true,
        // Standard semantics stated explicitly: the dialects disagree about `target`.
        tsconfigRaw: { compilerOptions: { experimentalDecorators: false, useDefineForClassFields: true } },
      });

      return { code: result.code, map: result.map };
    },
  };
}

// Raw `buildSync` runs no plugins, so `virtual:kinu-slate-vendor` aliases to this materialized module.
const slateVendorModulePath = fileURLToPath(new URL('../../node_modules/.cache/kinu/slate-vendor.js', import.meta.url));

mkdirSync(dirname(slateVendorModulePath), { recursive: true });

writeFileSync(slateVendorModulePath, `export default ${JSON.stringify(buildSlateVendor())};\n`);

const workerCompatibility = { compatibilityDate: '2025-12-01', compatibilityFlags: ['nodejs_compat'] };

/** Probe bundles reach miniflare as an ES module entry plus compiled `.wasm`. */
function probeModules(bundle: OutputFile[]): V4ModuleDefinition[] {
  return bundle.map((file) => ({
    type: file.path.endsWith('.wasm') ? 'CompiledWasm' : 'ESModule',
    path: file.path, contents: file.path.endsWith('.wasm') ? file.contents : file.text,
  }));
}

const hostedPreviewProbe = buildSync({
  entryPoints: [fileURLToPath(new URL('./tests/workerd/preview-port-probe.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./tests/workerd/.compiled/preview-port-probe.js', import.meta.url)),
  bundle: true, write: false, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
  external: ['cloudflare:*', 'node:*'], loader: { '.wasm': 'copy' },
}).outputFiles.sort((left, right) => Number(left.path.endsWith('.wasm')) - Number(right.path.endsWith('.wasm')));

const slateActorProbe = buildSync({
  entryPoints: [fileURLToPath(new URL('./tests/workerd/slate-actor-probe.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./tests/workerd/.compiled/slate-actor-probe.js', import.meta.url)),
  bundle: true, write: false, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser'],
  target: 'es2022',
  alias: { 'virtual:kinu-slate-vendor': slateVendorModulePath, ...Object.fromEntries(builtinModules.filter((name) => !name.startsWith('node:')).map((name) => [name, 'node:' + name])) },
  external: ['cloudflare:*', 'node:*'], loader: { '.wasm': 'copy' },
}).outputFiles.sort((left, right) => Number(left.path.endsWith('.wasm')) - Number(right.path.endsWith('.wasm')));

const slateShareProbe = buildSync({
  entryPoints: [fileURLToPath(new URL('./tests/workerd/slate-share-probe.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./tests/workerd/.compiled/slate-share-probe.js', import.meta.url)),
  bundle: true, write: false, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser'],
  target: 'es2022',
  alias: { 'virtual:kinu-slate-vendor': slateVendorModulePath, ...Object.fromEntries(builtinModules.filter((name) => !name.startsWith('node:')).map((name) => [name, 'node:' + name])) },
  external: ['cloudflare:*', 'node:*'], loader: { '.wasm': 'copy' },
}).outputFiles.sort((left, right) => Number(left.path.endsWith('.wasm')) - Number(right.path.endsWith('.wasm')));

const planAnnounceProbe = buildSync({
  entryPoints: [fileURLToPath(new URL('./tests/workerd/plan-announce-probe.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./tests/workerd/.compiled/plan-announce-probe.js', import.meta.url)),
  bundle: true, write: false, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser'], target: 'es2022', keepNames: true,
  alias: { 'virtual:kinu-slate-vendor': slateVendorModulePath, ...Object.fromEntries(builtinModules.filter((name) => !name.startsWith('node:')).map((name) => [name, 'node:' + name])) },
  external: ['cloudflare:*', 'node:*'], loader: { '.wasm': 'copy' },
}).outputFiles.sort((left, right) => Number(left.path.endsWith('.wasm')) - Number(right.path.endsWith('.wasm')));

const slateEgressProbe = buildSync({
  entryPoints: [fileURLToPath(new URL('./tests/workerd/slate-egress-probe.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./tests/workerd/.compiled/slate-egress-probe.js', import.meta.url)),
  bundle: true, write: false, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser'], target: 'es2022',
  alias: { 'virtual:kinu-slate-vendor': slateVendorModulePath, ...Object.fromEntries(builtinModules.filter((name) => !name.startsWith('node:')).map((name) => [name, 'node:' + name])) },
  external: ['cloudflare:*', 'node:*'], loader: { '.wasm': 'copy' },
}).outputFiles.sort((left, right) => Number(left.path.endsWith('.wasm')) - Number(right.path.endsWith('.wasm')));

const twoTurnProbe = buildSync({
  entryPoints: [fileURLToPath(new URL('./tests/workerd/two-turn-probe.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./tests/workerd/.compiled/two-turn-probe.js', import.meta.url)),
  bundle: true, write: false, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser'], target: 'es2022',
  alias: { 'virtual:kinu-slate-vendor': slateVendorModulePath, ...Object.fromEntries(builtinModules.filter((name) => !name.startsWith('node:')).map((name) => [name, 'node:' + name])) },
  external: ['cloudflare:*', 'node:*'], loader: { '.wasm': 'copy' },
}).outputFiles.sort((left, right) => Number(left.path.endsWith('.wasm')) - Number(right.path.endsWith('.wasm')));

const hireProbe = buildSync({
  entryPoints: [fileURLToPath(new URL('./tests/workerd/hire-probe.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./tests/workerd/.compiled/hire-probe.js', import.meta.url)),
  bundle: true, write: false, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser'], target: 'es2022',
  alias: { 'virtual:kinu-slate-vendor': slateVendorModulePath, ...Object.fromEntries(builtinModules.filter((name) => !name.startsWith('node:')).map((name) => [name, 'node:' + name])) },
  external: ['cloudflare:*', 'node:*'], loader: { '.wasm': 'copy' },
}).outputFiles.sort((left, right) => Number(left.path.endsWith('.wasm')) - Number(right.path.endsWith('.wasm')));

const accountResetProbe = buildSync({
  entryPoints: [fileURLToPath(new URL('./tests/workerd/account-reset-probe.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./tests/workerd/.compiled/account-reset-probe.js', import.meta.url)),
  bundle: true, write: false, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser'], target: 'es2022', keepNames: true,
  alias: { 'virtual:kinu-slate-vendor': slateVendorModulePath, ...Object.fromEntries(builtinModules.filter((name) => !name.startsWith('node:')).map((name) => [name, 'node:' + name])) },
  external: ['cloudflare:*', 'node:*'], loader: { '.wasm': 'copy' },
}).outputFiles.sort((left, right) => Number(left.path.endsWith('.wasm')) - Number(right.path.endsWith('.wasm')));

const slateDurabilityProbe = buildSync({
  entryPoints: [fileURLToPath(new URL('./tests/workerd/slate-durability-probe.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./tests/workerd/.compiled/slate-durability-probe.js', import.meta.url)),
  bundle: true, write: false, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser'], target: 'es2022',
  alias: { 'virtual:kinu-slate-vendor': slateVendorModulePath, ...Object.fromEntries(builtinModules.filter((name) => !name.startsWith('node:')).map((name) => [name, 'node:' + name])) },
  external: ['cloudflare:*', 'node:*'], loader: { '.wasm': 'copy' },
}).outputFiles.sort((left, right) => Number(left.path.endsWith('.wasm')) - Number(right.path.endsWith('.wasm')));

const publicSurfaceProbe = buildSync({
  entryPoints: [fileURLToPath(new URL('./tests/workerd/public-surface-probe.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./tests/workerd/.compiled/public-surface-probe.js', import.meta.url)),
  bundle: true, write: false, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser'], target: 'es2022', keepNames: true,
  alias: { 'virtual:kinu-slate-vendor': slateVendorModulePath, ...Object.fromEntries(builtinModules.filter((name) => !name.startsWith('node:')).map((name) => [name, 'node:' + name])) },
  external: ['cloudflare:*', 'node:*'], loader: { '.wasm': 'copy' },
}).outputFiles.sort((left, right) => Number(left.path.endsWith('.wasm')) - Number(right.path.endsWith('.wasm')));

const deployRunProbe = buildSync({
  entryPoints: [fileURLToPath(new URL('./tests/workerd/deploy-run-probe.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./tests/workerd/.compiled/deploy-run-probe.js', import.meta.url)),
  bundle: true, write: false, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser'], target: 'es2022',
  external: ['cloudflare:*', 'node:*'], loader: { '.wasm': 'copy' },
}).outputFiles.sort((left, right) => Number(left.path.endsWith('.wasm')) - Number(right.path.endsWith('.wasm')));

let forbiddenEgressHits = 0;

export default defineConfig({
  plugins: [
    promptText(),
    slateVendor(),
    standardDecorators(),
    cloudflareTest({
      main: './tests/workerd/worker.ts',
      miniflare: {
        ...workerCompatibility,
        // `useSQLite` mirrors `new_sqlite_classes` (wrangler.jsonc:100-115); without it `ctx.storage.sql`
        // throws. `LOADER` mirrors `worker_loaders` for the real codemode executor.
        workerLoaders: { LOADER: {} },
        modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
        // The privileged Vitest runner permits eval and would mask the hosted Node refusal.
        workers: [{
          name: 'hosted-preview-probe', ...workerCompatibility,
          modules: probeModules(hostedPreviewProbe),
          durableObjects: { PREVIEW_PORT_PROBE: { className: 'PreviewPortProbeDO', useSQLite: true } },
        }, {
          workerLoaders: { LOADER: {} },
          name: 'slate-actor-probe', ...workerCompatibility,
          modules: probeModules(slateActorProbe),
          durableObjects: {
            SLATE_ACTOR_ROOT: { className: 'SlateActorProbeRoot', useSQLite: true },
          },
        }, {
          // Bound as `OrchestratorAgent` because production `workspaceOwner()` reads that name off `env`.
          name: 'plan-announce-probe', ...workerCompatibility, workerLoaders: { LOADER: {} },
          modules: probeModules(planAnnounceProbe),
          durableObjects: {
            OrchestratorAgent: { className: 'OrchestratorAgent', useSQLite: true },
            UserDO: { className: 'UserDO', useSQLite: true },
            USER_SOCKET_PROBE: { className: 'UserSocketProbeDO', useSQLite: true },
          },
        }, {
          name: 'slate-egress-probe', ...workerCompatibility, workerLoaders: { LOADER: {} },
          modules: probeModules(slateEgressProbe),
          durableObjects: { SLATE_EGRESS_PROBE: { className: 'SlateEgressProbe', useSQLite: true } },
          // Final transport only: the actual CodemodeEgress policy and resident
          // global fetch run above this mock. No unmatched request reaches a network.
          outboundService: async (request) => {
            const url = new URL(request.url);

            if (url.origin === 'http://169.254.169.254') {
              forbiddenEgressHits += 1;

              return new Response('forbidden transport reached');
            }

            if (url.origin === 'https://example.com') {
              if (url.pathname === '/control') return new Response('public control');

              if (url.pathname === '/redirect') return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/forbidden' } });

              if (url.pathname === '/seen') return Response.json({ forbiddenEgressHits });
            }

            throw new Error('Unmatched test egress is disabled: ' + request.url);
          },
        }, {
          // `env.AI` is a service binding to this worker's FakeAI, so the model plane stays in-pool.
          name: 'two-turn-probe',
          compatibilityDate: workerCompatibility.compatibilityDate,
          // workerd marshals `request.signal` over RPC only under this flag
          // ("AbortSignal serialization is not enabled" otherwise).
          compatibilityFlags: [...workerCompatibility.compatibilityFlags, 'enable_abortsignal_rpc'],
          workerLoaders: { LOADER: {} },
          modules: probeModules(twoTurnProbe),
          bindings: { DEV_USER_EMAIL: 'probe@local', CREDENTIAL_ENCRYPTION_KEY: 'dHdvLXR1cm4tcHJvYmUtY3JlZGVudGlhbC1rZXktMzI=' },
          serviceBindings: { AI: { name: kCurrentWorker, entrypoint: 'FakeAI' } },
          // Compat HTTP falls back to the
          // global fetch (owned-model-services passes no deps.fetch), which
          // routes to the Node-side fake; unknown hosts throw.
          outboundService: probeOutbound,
          durableObjects: {
            TWO_TURN_PROBE: { className: 'TwoTurnProbeRoot', useSQLite: true },
            OrchestratorAgent: { className: 'OrchestratorAgent', useSQLite: true },
            UserDO: { className: 'UserDO', useSQLite: true },
          },
        }, {
          // A real hire: the child's `workers-ai/` tier arrives on the AI binding, the root's
          // `openai-compat` lane on outbound.
          name: 'hire-probe',
          compatibilityDate: workerCompatibility.compatibilityDate,
          compatibilityFlags: [...workerCompatibility.compatibilityFlags, 'enable_abortsignal_rpc'],
          workerLoaders: { LOADER: {} },
          modules: probeModules(hireProbe),
          bindings: { DEV_USER_EMAIL: 'probe@local', CREDENTIAL_ENCRYPTION_KEY: 'dHdvLXR1cm4tcHJvYmUtY3JlZGVudGlhbC1rZXktMzI=' },
          serviceBindings: { AI: { name: kCurrentWorker, entrypoint: 'HireAI' } },
          outboundService: hireOutbound,
          durableObjects: {
            HIRE_PROBE: { className: 'HireProbeRoot', useSQLite: true },
            OrchestratorAgent: { className: 'OrchestratorAgent', useSQLite: true },
            UserDO: { className: 'UserDO', useSQLite: true },
          },
        }, {
          // Nimbus port reservations live in workspace storage, so preview URLs survive
          // `abortAllDurableObjects()`.
          name: 'slate-durability-probe', ...workerCompatibility, workerLoaders: { LOADER: {} },
          modules: probeModules(slateDurabilityProbe),
          bindings: {
            PREVIEW_HOST_SUFFIX: 'preview.test',
            DEV_USER_EMAIL: 'probe@local',
            CREDENTIAL_ENCRYPTION_KEY: 'dHdvLXR1cm4tcHJvYmUtY3JlZGVudGlhbC1rZXktMzI=',
          },
          outboundService: registryOutbound,
          durableObjects: {
            SLATE_DURABILITY_PROBE: { className: 'SlateDurabilityProbeRoot', useSQLite: true },
            OrchestratorAgent: { className: 'OrchestratorAgent', useSQLite: true },
            UserDO: { className: 'UserDO', useSQLite: true },
          },
        }, {
          // `SlateBinding` resolves `env.OrchestratorAgent`, so the probe class is bound under that name too.
          name: 'slate-share-probe', ...workerCompatibility, workerLoaders: { LOADER: {} },
          modules: probeModules(slateShareProbe),
          durableObjects: {
            SLATE_SHARE_PROBE: { className: 'SlateShareProbeDO', useSQLite: true },
            OrchestratorAgent: { className: 'SlateShareProbeDO', useSQLite: true },
          },
        }, {
          name: 'account-reset-probe', ...workerCompatibility, workerLoaders: { LOADER: {} },
          modules: probeModules(accountResetProbe),
          bindings: { CREDENTIAL_ENCRYPTION_KEY: 'dHdvLXR1cm4tcHJvYmUtY3JlZGVudGlhbC1rZXktMzI=' },
          outboundService: async (request) => {
            throw new Error('Unmatched test egress is disabled: ' + request.url);
          },
          durableObjects: {
            ACCOUNT_RESET_PROBE: { className: 'AccountResetProbeDO', useSQLite: true },
            OrchestratorAgent: { className: 'OrchestratorAgent', useSQLite: true },
            UserDO: { className: 'UserDO', useSQLite: true },
          },
        }, {
          // The production Worker entry (`route()`), reached over `PUBLIC_SURFACE`; same
          // `enable_abortsignal_rpc` reason as two-turn-probe.
          name: 'public-surface-probe',
          compatibilityDate: workerCompatibility.compatibilityDate,
          compatibilityFlags: [...workerCompatibility.compatibilityFlags, 'enable_abortsignal_rpc'],
          workerLoaders: { LOADER: {} },
          modules: probeModules(publicSurfaceProbe),
          // `DEV_USER_EMAIL` selects the dev inference plane and the loopback identity.
          bindings: { DEV_USER_EMAIL: 'probe@local', CREDENTIAL_ENCRYPTION_KEY: 'dHdvLXR1cm4tcHJvYmUtY3JlZGVudGlhbC1rZXktMzI=' },
          serviceBindings: { AI: { name: kCurrentWorker, entrypoint: 'SurfaceAI' } },
          outboundService: probeOutbound,
          durableObjects: {
            OrchestratorAgent: { className: 'OrchestratorAgent', useSQLite: true },
            UserDO: { className: 'UserDO', useSQLite: true },
          },
        }, {
          // Self-deployment against real DO SQLite; every external host is the Node-side fake, unmatched throws.
          name: 'deploy-probe', ...workerCompatibility,
          modules: probeModules(deployRunProbe),
          // Root secrets are bound because a self-update's vault reads through to them.
          bindings: {
            CLI_PUBLIC_ORIGIN: DEPLOY_FAKE_CHANNEL,
            KINU_DEPLOYMENT_RECORD: DEPLOY_FAKE_RECORD,
            KINU_SELF_DEPLOY_REFRESH_TOKEN: DEPLOY_FAKE_REFRESH_TOKEN,
            CREDENTIAL_ENCRYPTION_KEY: 'ZGVwbG95LXByb2JlLWNyZWRlbnRpYWwta2V5LTMyYg==',
            WEBHOOK_ROUTE_SECRET: 'ZGVwbG95LXByb2JlLXdlYmhvb2stcm91dGUtc2VjcmV0',
            // Without it the door answers 503 to every leg (the unconfigured deployment).
            CLOUDFLARE_DEPLOY_CLIENT_ID: DEPLOY_FAKE_CLIENT_ID,
          },
          outboundService: deployOutbound,
          serviceBindings: { ASSETS: assetsOutbound },
          durableObjects: {
            DEPLOY_RUN_PROBE: { className: 'DeployRunProbeDO', useSQLite: true },
            // `/api/updates/apply` addresses the run through `env.DeployRunDO`.
            DeployRunDO: { className: 'DeployRunProbeDO', useSQLite: true },
          },
        }],
        // A miniflare service binding carries a WebSocket upgrade (measured 2026-09-16), so the chat
        // protocol runs in-pool.
        serviceBindings: {
          PUBLIC_SURFACE: { name: 'public-surface-probe' },
          // Node-side fake state is shared across workers; these entrypoints reset and read it.
          SURFACE_CONTROL: { name: 'public-surface-probe', entrypoint: 'SurfaceControl' },
          DEPLOY_FAKE: { name: 'deploy-probe', entrypoint: 'DeployFakeControl' },
          UPDATES_PROBE: { name: 'deploy-probe', entrypoint: 'UpdatesProbe' },
          DEPLOY_DOOR_PROBE: { name: 'deploy-probe', entrypoint: 'DeployDoorProbe' },
        },
        durableObjects: {
          RETENTION: { className: 'RetentionDO', useSQLite: true },
          NEIGHBOUR: { className: 'NeighbourDO', useSQLite: true },
          GATED: { className: 'GatedDO', useSQLite: true },
          TRANSACTION: { className: 'TransactionDO', useSQLite: true },
          SOCKET: { className: 'SocketDO', useSQLite: true },
          ALARMED: { className: 'AlarmDO', useSQLite: true },
          CACHE_WARM_PROBE: { className: 'CacheWarmProbeDO', useSQLite: true },
          EVICTION_PROBE: { className: 'EvictionProbeDO', useSQLite: true },
          WITNESS: { className: 'WitnessDO', useSQLite: true },
          SPEND_PROBE: { className: 'SpendProbeDO', useSQLite: true },
          TERMINAL_EFFECT_PROBE: { className: 'TerminalEffectProbeDO', useSQLite: true },
          DB_CAPABILITY_PROBE: { className: 'DbCapabilityProbeDO', useSQLite: true },
          FIBER_RECOVERY_PROBE: { className: 'FiberRecoveryProbeAgent', useSQLite: true },
          FORK_SOURCE: { className: 'ForkSourceProbeDO', useSQLite: true },
          FORK_TARGET: { className: 'ForkTargetProbeDO', useSQLite: true },
          STREAM_LIFECYCLE: { className: 'StreamLifecycleDO', useSQLite: true },
          FILES_EIO_PROBE: { className: 'FilesEioProbeDO', useSQLite: true },
          PREVIEW_PORT_PROBE: { className: 'PreviewPortProbeDO', scriptName: 'hosted-preview-probe', useSQLite: true },
          SLATE_PROCESS_PROBE: { className: 'SlateProcessProbeDO', useSQLite: true },
          SLATE_SHARE_PROBE: { className: 'SlateShareProbeDO', scriptName: 'slate-share-probe', useSQLite: true },
          SLATE_ACTOR_ROOT: { className: 'SlateActorProbeRoot', scriptName: 'slate-actor-probe', useSQLite: true },
          PLAN_ANNOUNCE_ROOT: { className: 'OrchestratorAgent', scriptName: 'plan-announce-probe', useSQLite: true },
          USER_SOCKET_PROBE: { className: 'UserSocketProbeDO', scriptName: 'plan-announce-probe', useSQLite: true },
          SLATE_EGRESS_PROBE: { className: 'SlateEgressProbe', scriptName: 'slate-egress-probe', useSQLite: true },
          DEVICE_LEDGER_PROBE: { className: 'DeviceLedgerProbeDO', useSQLite: true },
          TWO_TURN_PROBE: { className: 'TwoTurnProbeRoot', scriptName: 'two-turn-probe', useSQLite: true },
          HIRE_PROBE: { className: 'HireProbeRoot', scriptName: 'hire-probe', useSQLite: true },
          DEVBOX_NOT_READY_PROBE: { className: 'DevboxNotReadyProbeDO', useSQLite: true },
          SLATE_DURABILITY_PROBE: { className: 'SlateDurabilityProbeRoot', scriptName: 'slate-durability-probe', useSQLite: true },
          ACCOUNT_RESET_PROBE: { className: 'AccountResetProbeDO', scriptName: 'account-reset-probe', useSQLite: true },
          DEPLOY_RUN_PROBE: { className: 'DeployRunProbeDO', scriptName: 'deploy-probe', useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ['tests/workerd/**/*.test.ts'],
    // Asserts the pool actually started (adopted from cloudflare-os `test-setup/assert-workerd.ts`).
    setupFiles: ['./tests/workerd/assert-workerd.ts'],
    // Wall-time gate assertions would contend under per-file parallelism.
    fileParallelism: false,
    // One runner and Miniflare per row (pool-workers 0.22 dropped `singleWorker`); measured 2026-09-18 a
    // large drop in row time. Suites share an isolate, so each mints its own DO names.
    isolate: false,
    // No per-test clock (`gate:test-clocks` pins `0`): waits end on their condition and the ladder kills
    // hangs. Measured 2026-09-16, a file's first test pays pool boot, past Vitest's default timeout.
    testTimeout: 0,
    hookTimeout: 0,
    // Deliberate probe rejections only; anything else stays fatal. DO-side rejections may reach this
    // hook depending on the pool (measured 2026-09-16: they did not yet), so they are listed anyway.
    onUnhandledError(error) {
      // `AlarmDO.alarm` rethrows so the runtime owns redelivery (worker.ts:503-506).
      if (error.message.includes('alarm-body-failed')) return false;

      // `TransactionDO`'s async-body arm throws after commit, with no owner (worker.ts:258, :289).
      if (error.message.includes('unknown subordinate "relay"')) return false;

      // `deploy-ledger.test.ts` aborts a DeployRunDO mid-plan on purpose.
      if (error.message.includes('probe: the object died mid-plan')) return false;
    },
  },
});
