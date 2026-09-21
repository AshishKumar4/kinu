/**
 * The workerd layer. ONE narrow purpose, stated here because a second test
 * runner in a repository that has exactly one is a parallel system unless the
 * boundary is written down and enforced.
 *
 * WHAT BELONGS HERE: a test whose assertion is about the PLATFORM — the Durable
 * Object output gate, the `blockConcurrencyWhile` input gate, actor-shutdown
 * cancellation, facet storage lifetime, native span `isTraced`. Every one of
 * those is a semantic `bun test` cannot host, and every runtime defect this
 * project has shipped was in that set and was found by a deployed probe rather
 * than by 1,100 passing tests.
 *
 * WHAT DOES NOT: anything whose assertion is about OUR code. Pure functions,
 * SQL shapes, protocol encoding, prompt assembly, reducers — those stay in
 * `bun test`, which is faster and is where the other ~450 test files live.
 *
 * "SQL shapes" means our arithmetic, not the database's feature set. A query
 * whose METHOD is a platform capability belongs here: `do-spend-aggregate` runs
 * the workspace-spend aggregate because `WITH` and `json_extract` over a Durable
 * Object's SQLite are the platform's to provide, and `bun:sqlite` having them
 * says nothing about workerd. Its arithmetic is asserted under `bun test`, where
 * it belongs.
 *
 * The boundary is MECHANICAL, not a convention:
 *   - `include` below is exactly `tests/workerd/**`, so vitest cannot reach a
 *     bun test.
 *   - `bunfig.toml` `pathIgnorePatterns` carries the matching per-package
 *     `tests/workerd` glob, so `bun test` cannot reach a workerd test.
 *   - `scripts/ladder.test.ts` asserts those two globs are disjoint and that
 *     each selects a non-empty set, so neither can quietly become empty.
 *
 * `compatibilityDate` and `compatibilityFlags` are pinned to the same values as
 * `wrangler.jsonc:6,10`. A layer that measures a different runtime than the one
 * we deploy measures a different system.
 *
 * TYPES ARE SPLIT THE SAME WAY. `tests/workerd` is its own tsc project and
 * `tsconfig.json` here excludes it, because `tests/workerd/env.d.ts` declares
 * the TEST worker's three Durable Object bindings on `Cloudflare.Env`.
 * Compiling both together merges those into the production surface and every
 * `Env` in src/ starts reporting three missing namespaces. `bun run check`
 * names both projects. Neither tsconfig may carry a comment: tsc accepts JSONC
 * there, but `scripts/capability-parity.ts` reads tsconfig with `JSON.parse`.
 */
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { buildSync, transform } from 'esbuild';
import { buildSlateVendor, slateVendor } from './slate-vendor';
import { defineConfig, type Plugin } from 'vitest/config';
import { probeOutbound } from './tests/workerd/http-model-fake';
import { hireOutbound } from './tests/workerd/hire-model-fake';
import { registryOutbound } from './tests/workerd/npm-registry-fake';
import {
  DEPLOY_FAKE_CHANNEL, DEPLOY_FAKE_CLIENT_ID, DEPLOY_FAKE_RECORD, DEPLOY_FAKE_REFRESH_TOKEN,
  assetsOutbound, deployOutbound,
} from './tests/workerd/deploy-fake';
import { kCurrentWorker } from 'miniflare';
import { builtinModules } from 'node:module';
import { promptText } from './vite-prompt-text';

/**
 * `@callable()` is a TC39 standard decorator, and Vite 8 transforms TypeScript
 * with oxc, whose only decorator support is the LEGACY (pre-standard) form. On a
 * decorated module oxc strips the types and emits the `@` unchanged, so the
 * module reaches the runtime as `SyntaxError: Invalid or unexpected token`. That
 * is what would confine this layer to undecorated probe classes and keep it from
 * loading a production Agent: not a charter decision, a transform gap. KINU-065.
 *
 * Turning on oxc's `decorator.legacy` would be worse than the gap. Legacy
 * semantics hand the decorator the PROTOTYPE where the standard hands it the
 * method function, and the SDK keys its callable registry by the method
 * function. Every `@callable()` would register the wrong key and the whole
 * browser RPC surface would silently disappear, which is the exact defect
 * `tests/workerd/decorated-agent.test.ts` exists to catch.
 *
 * esbuild is used because it is what PRODUCTION uses: `wrangler deploy` bundles
 * `wrangler.jsonc`'s `main` with esbuild. The rest of this file already refuses
 * to measure a runtime we do not deploy; the transform is the same argument.
 *
 * Scoped to modules that really carry a decorator, so oxc keeps every file it
 * already handles and this pass cannot become a second bundler by accident.
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
        // Standard semantics, stated rather than inherited: this pass exists
        // because the two decorator dialects disagree about what `target` is.
        tsconfigRaw: { compilerOptions: { experimentalDecorators: false, useDefineForClassFields: true } },
      });

      return { code: result.code, map: result.map };
    },
  };
}

// The probe bundles below are raw esbuild `buildSync`, which cannot run
// plugins — so `virtual:kinu-slate-vendor` resolves by alias to the same
// module text the Vite plugin serves, materialized once per config load.
const slateVendorModulePath = fileURLToPath(new URL('../../node_modules/.cache/kinu/slate-vendor.js', import.meta.url));

mkdirSync(dirname(slateVendorModulePath), { recursive: true });

writeFileSync(slateVendorModulePath, `export default ${JSON.stringify(buildSlateVendor())};\n`);

const workerCompatibility = { compatibilityDate: '2025-12-01', compatibilityFlags: ['nodejs_compat'] };

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
        // `new_sqlite_classes` in wrangler.jsonc:100-115 is what production
        // registers these under; miniflare spells the same thing `useSQLite`.
        // Without it `ctx.storage.sql` throws and the init-gate read would
        // measure an error path instead of the gate.
        // The dynamic-Worker loader `eval` runs programs through
        // (`wrangler.jsonc` `worker_loaders`), so the sandbox test below runs
        // the real @cloudflare/codemode executor over the real module graph.
        workerLoaders: { LOADER: {} },
        modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
        // The privileged Vitest runner permits eval and would mask the hosted Node refusal.
        workers: [{
          name: 'hosted-preview-probe', ...workerCompatibility,
          modules: hostedPreviewProbe.map((file) => ({
            type: file.path.endsWith('.wasm') ? 'CompiledWasm' : 'ESModule',
            path: file.path, contents: file.path.endsWith('.wasm') ? file.contents : file.text,
          })),
          durableObjects: { PREVIEW_PORT_PROBE: { className: 'PreviewPortProbeDO', useSQLite: true } },
        }, {
          // The seal target is the production root itself, bound here under
          // its own names: `exercise` addresses it by binding (never by a
          // retyped subclass), and the root's directory and UserDO hub resolve
          // exactly as they do in production. `SLATE_ACTOR_ROOT` is this
          // file's probe root, which owns no identity row and answers only
          // the two fixture methods the tests drive.
          workerLoaders: { LOADER: {} },
          name: 'slate-actor-probe', ...workerCompatibility,
          modules: slateActorProbe.map((file) => ({
            type: file.path.endsWith('.wasm') ? 'CompiledWasm' : 'ESModule',
            path: file.path, contents: file.path.endsWith('.wasm') ? file.contents : file.text,
          })),
          durableObjects: {
            SLATE_ACTOR_ROOT: { className: 'SlateActorProbeRoot', useSQLite: true },
            OrchestratorAgent: { className: 'OrchestratorAgent', useSQLite: true },
            UserDO: { className: 'UserDO', useSQLite: true },
          },
        }, {
          // The child resolves its workspace through a binding named exactly
          // `OrchestratorAgent`, because that is the name the production
          // `workspaceOwner()` reads off `env`. Same class, same script as the
          // outer `PLAN_ANNOUNCE_ROOT`, so both address one object.
          name: 'plan-announce-probe', ...workerCompatibility, workerLoaders: { LOADER: {} },
          modules: planAnnounceProbe.map((file) => ({
            type: file.path.endsWith('.wasm') ? 'CompiledWasm' : 'ESModule',
            path: file.path, contents: file.path.endsWith('.wasm') ? file.contents : file.text,
          })),
          durableObjects: {
            OrchestratorAgent: { className: 'OrchestratorAgent', useSQLite: true },
            // The owner's plane the root's runtime reaches once an owner is
            // claimed, which is what registers the child actor this probe
            // rosters.
            UserDO: { className: 'UserDO', useSQLite: true },
            USER_SOCKET_PROBE: { className: 'UserSocketProbeDO', useSQLite: true },
          },
        }, {
          name: 'slate-egress-probe', ...workerCompatibility, workerLoaders: { LOADER: {} },
          modules: slateEgressProbe.map((file) => ({
            type: file.path.endsWith('.wasm') ? 'CompiledWasm' : 'ESModule',
            path: file.path, contents: file.path.endsWith('.wasm') ? file.contents : file.text,
          })),
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
          // Two real OrchestratorAgent turns end to end. `env.AI` is a service
          // binding to this worker's own FakeAI WorkerEntrypoint — the direct
          // Workers AI development path (agent-registry.ts:117) needs only
          // `.run(model, inputs, options)`, so the external model plane is
          // intercepted inside the pool and no production flag exists.
          name: 'two-turn-probe',
          compatibilityDate: workerCompatibility.compatibilityDate,
          // AbortSignal over the service binding: the adapter hands
          // `request.signal` to `binding.run` unconditionally, and workerd
          // gates that marshalling behind this flag ("AbortSignal
          // serialization is not enabled" without it).
          compatibilityFlags: [...workerCompatibility.compatibilityFlags, 'enable_abortsignal_rpc'],
          workerLoaders: { LOADER: {} },
          modules: twoTurnProbe.map((file) => ({
            type: file.path.endsWith('.wasm') ? 'CompiledWasm' : 'ESModule',
            path: file.path, contents: file.path.endsWith('.wasm') ? file.contents : file.text,
          })),
          // The owner-capability secret — `ownerCaller` derives the probe's
          // root caller from it, exactly as the Worker routes do.
          bindings: { DEV_USER_EMAIL: 'probe@local', CREDENTIAL_ENCRYPTION_KEY: 'dHdvLXR1cm4tcHJvYmUtY3JlZGVudGlhbC1rZXktMzI=' },
          serviceBindings: { AI: { name: kCurrentWorker, entrypoint: 'FakeAI' } },
          // The turn's HTTP model plane: compat requests fall back to the
          // global fetch (owned-model-services passes no deps.fetch), which
          // this worker's outboundService routes to the Node-side fake above.
          // Same fail-and-record pattern as slate-egress-probe — unknown
          // hosts throw, so the first genuinely required harness call is
          // identified, not silently swallowed.
          outboundService: probeOutbound,
          durableObjects: {
            TWO_TURN_PROBE: { className: 'TwoTurnProbeRoot', useSQLite: true },
            OrchestratorAgent: { className: 'OrchestratorAgent', useSQLite: true },
            UserDO: { className: 'UserDO', useSQLite: true },
          },
        }, {
          // The delegation tier: a real hire, authored by the model through the
          // real `agents` tool, run against a real OrchestratorAgent. Same
          // shape as the two-turn worker — the shipped orchestrator under the
          // production name, its own AI service binding for the CHILD's wire
          // (a hosted actor's tier model is a `workers-ai/` spec, so its turn
          // arrives on the binding and not on HTTP), and its own outbound for
          // the ROOT's pinned `openai-compat` lane.
          name: 'hire-probe',
          compatibilityDate: workerCompatibility.compatibilityDate,
          compatibilityFlags: [...workerCompatibility.compatibilityFlags, 'enable_abortsignal_rpc'],
          workerLoaders: { LOADER: {} },
          modules: hireProbe.map((file) => ({
            type: file.path.endsWith('.wasm') ? 'CompiledWasm' : 'ESModule',
            path: file.path, contents: file.path.endsWith('.wasm') ? file.contents : file.text,
          })),
          bindings: { DEV_USER_EMAIL: 'probe@local', CREDENTIAL_ENCRYPTION_KEY: 'dHdvLXR1cm4tcHJvYmUtY3JlZGVudGlhbC1rZXktMzI=' },
          serviceBindings: { AI: { name: kCurrentWorker, entrypoint: 'HireAI' } },
          outboundService: hireOutbound,
          durableObjects: {
            HIRE_PROBE: { className: 'HireProbeRoot', useSQLite: true },
            OrchestratorAgent: { className: 'OrchestratorAgent', useSQLite: true },
            UserDO: { className: 'UserDO', useSQLite: true },
          },
        }, {
          // The durable-slate probe: the production preview edge
          // (`handleNimbusPreviewHostRequest`) driven against a real
          // OrchestratorAgent across `abortAllDurableObjects()`. The workspace
          // object holds Nimbus's port reservations in its own storage, so the
          // URL outlives the isolate that served it — which is exactly what
          // the test asserts. `ObservedOrchestrator` is the production class
          // plus the `portReservations` fixture read, bound under the
          // production name as in two-turn-probe.
          name: 'slate-durability-probe', ...workerCompatibility, workerLoaders: { LOADER: {} },
          modules: slateDurabilityProbe.map((file) => ({
            type: file.path.endsWith('.wasm') ? 'CompiledWasm' : 'ESModule',
            path: file.path, contents: file.path.endsWith('.wasm') ? file.contents : file.text,
          })),
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
          // The share rail's DO side: a real SlateHost over its own SQLite,
          // isolated from the runner's bindings exactly the way
          // `slate-actor-probe` isolates the decorated actor. The slate's
          // FILES binding is a `SlateBinding` worker entrypoint that resolves
          // `workspaceOwner(env, workspace)` — `env.OrchestratorAgent` — so the
          // probe class is bound under that name too: same className, same
          // scriptName, one object per name.
          name: 'slate-share-probe', ...workerCompatibility, workerLoaders: { LOADER: {} },
          modules: slateShareProbe.map((file) => ({
            type: file.path.endsWith('.wasm') ? 'CompiledWasm' : 'ESModule',
            path: file.path, contents: file.path.endsWith('.wasm') ? file.contents : file.text,
          })),
          durableObjects: {
            SLATE_SHARE_PROBE: { className: 'SlateShareProbeDO', useSQLite: true },
            OrchestratorAgent: { className: 'SlateShareProbeDO', useSQLite: true },
          },
        }, {
          // Account deletion end to end: the production UserDO (as the probe
          // subclass, sealed through the production seal) tearing down the
          // production OrchestratorAgent objects it registered, then itself.
          // No model plane and no network: nothing here runs a turn.
          name: 'account-reset-probe', ...workerCompatibility, workerLoaders: { LOADER: {} },
          modules: accountResetProbe.map((file) => ({
            type: file.path.endsWith('.wasm') ? 'CompiledWasm' : 'ESModule',
            path: file.path, contents: file.path.endsWith('.wasm') ? file.contents : file.text,
          })),
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
          // The production Worker entry, reached from the runner over the
          // `PUBLIC_SURFACE` service binding below: `public-surface.test.ts`
          // drives `route()` itself — the REST create, the chat socket, the
          // transcript read — so the door the product is used through runs under
          // workerd rather than only against a deployment.
          //
          // Same model seam as two-turn-probe, and the flag for the same reason:
          // the direct Workers AI adapter hands `request.signal` to
          // `binding.run`, which workerd marshals only under
          // `enable_abortsignal_rpc`.
          name: 'public-surface-probe',
          compatibilityDate: workerCompatibility.compatibilityDate,
          compatibilityFlags: [...workerCompatibility.compatibilityFlags, 'enable_abortsignal_rpc'],
          workerLoaders: { LOADER: {} },
          modules: publicSurfaceProbe.map((file) => ({
            type: file.path.endsWith('.wasm') ? 'CompiledWasm' : 'ESModule',
            path: file.path, contents: file.path.endsWith('.wasm') ? file.contents : file.text,
          })),
          // `DEV_USER_EMAIL` is what makes `env.AI` the development inference
          // plane AND what the loopback identity is synthesized from; the
          // encryption key is the owner capability `ownerCaller` derives.
          bindings: { DEV_USER_EMAIL: 'probe@local', CREDENTIAL_ENCRYPTION_KEY: 'dHdvLXR1cm4tcHJvYmUtY3JlZGVudGlhbC1rZXktMzI=' },
          serviceBindings: { AI: { name: kCurrentWorker, entrypoint: 'FakeAI' } },
          // The turn's model plane, and the same handler the two-turn probe
          // uses: compat requests fall back to the global fetch, which this
          // worker's outboundService routes to the Node-side fake. Unmatched
          // hosts throw there, so nothing in a public-surface turn reaches a
          // network unnamed.
          outboundService: probeOutbound,
          durableObjects: {
            OrchestratorAgent: { className: 'OrchestratorAgent', useSQLite: true },
            UserDO: { className: 'UserDO', useSQLite: true },
          },
        }, {
          // The guided self-deployment, end to end against real Durable Object
          // SQLite. Everything it talks to is the Node-side plane installed as
          // this worker's `outboundService`: the Cloudflare API, the
          // authorization server the PKCE exchange posts to, the release
          // channel it downloads the artifact from, and the new deployment's
          // own `/api/health`. An unmatched host throws there, so a run that
          // reached a real network is a failure rather than a slow pass.
          name: 'deploy-probe', ...workerCompatibility,
          modules: deployRunProbe.map((file) => ({
            type: file.path.endsWith('.wasm') ? 'CompiledWasm' : 'ESModule',
            path: file.path, contents: file.path.endsWith('.wasm') ? file.contents : file.text,
          })),
          // The channel the run reads its release from, which is the one var
          // `DeployRunDO` uses to find it, and the state a DEPLOYED Kinu holds
          // about itself: the record its first run wrote and the refresh token
          // it owns. The two minted root secrets are bound because a
          // self-update's vault reads through to them — a version uploaded
          // without them would bind a new encryption key over the credentials
          // this deployment has already stored.
          bindings: {
            CLI_PUBLIC_ORIGIN: DEPLOY_FAKE_CHANNEL,
            KINU_DEPLOYMENT_RECORD: DEPLOY_FAKE_RECORD,
            KINU_SELF_DEPLOY_REFRESH_TOKEN: DEPLOY_FAKE_REFRESH_TOKEN,
            CREDENTIAL_ENCRYPTION_KEY: 'ZGVwbG95LXByb2JlLWNyZWRlbnRpYWwta2V5LTMyYg==',
            WEBHOOK_ROUTE_SECRET: 'ZGVwbG95LXByb2JlLXdlYmhvb2stcm91dGUtc2VjcmV0',
            // The OAuth client the door's own routes authorize through. Without
            // it the door answers 503 to every leg, which is the unconfigured
            // deployment rather than the door under test.
            CLOUDFLARE_DEPLOY_CLIENT_ID: DEPLOY_FAKE_CLIENT_ID,
          },
          outboundService: deployOutbound,
          // The deployment's own asset bundle, which holds exactly the build
          // stamp `/api/updates` reads to say what version it is running.
          serviceBindings: { ASSETS: assetsOutbound },
          durableObjects: {
            DEPLOY_RUN_PROBE: { className: 'DeployRunProbeDO', useSQLite: true },
            // The same class under the name production reaches it by, because
            // `/api/updates/apply` addresses the self-update run through
            // `env.DeployRunDO`.
            DeployRunDO: { className: 'DeployRunProbeDO', useSQLite: true },
          },
        }],
        // The runner's door to the production route table. A miniflare service
        // binding carries a WebSocket upgrade — measured 2026-09-16: 101 with a
        // live `response.webSocket` and a round-trip frame — which is what lets
        // the test speak the product's chat protocol in-pool rather than
        // re-entering through a Durable Object stub.
        serviceBindings: {
          PUBLIC_SURFACE: { name: 'public-surface-probe' },
          // The model fake's captured log is one Node-side module shared by
          // every worker bound to it; this is how the test hands it back empty.
          SURFACE_CONTROL: { name: 'public-surface-probe', entrypoint: 'SurfaceControl' },
          // The deploy fake's created-resource state is Node-side module state
          // too; this is how the test resets it and reads what a run made.
          DEPLOY_FAKE: { name: 'deploy-probe', entrypoint: 'DeployFakeControl' },
          // The deployment's own Updates surface, called as a session: the
          // production handlers over the production Durable Object, on the
          // worker that is bound like a deployed Kinu.
          UPDATES_PROBE: { name: 'deploy-probe', entrypoint: 'UpdatesProbe' },
          // The door's own routes on that worker: the callback's binding to the
          // browser that started a leg, and where the run key may travel.
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
    // Asserts the pool actually started, rather than trusting a green run to
    // mean workerd. Adopted from the owner's cloudflare-os
    // (`test-setup/assert-workerd.ts`); the file states what it measured.
    setupFiles: ['./tests/workerd/assert-workerd.ts'],
    // These tests measure gates and cancellation windows in wall time. Vitest's
    // default per-file parallelism would have two of them contend for the same
    // runtime and turn a latency assertion into a flake.
    fileParallelism: false,
    // One runner, one Miniflare, one module cache for the whole row. Under
    // vitest 4's pool model a fresh runner per file (the default, `isolate:
    // true`) boots a new Miniflare and re-imports the bundle for every file;
    // `@cloudflare/vitest-pool-workers` 0.22 has no `singleWorker` any more,
    // this is its replacement. Measured 2026-09-18 on this box (load 6-8):
    // the 29-file row went from 343 s (import 119 s, tests 66 s, the rest pool
    // boots) to 40 s (import 1.4 s), the 13-file long row from 330 s to 178 s,
    // every test green under both. What this gives up: a file no longer starts
    // in a fresh isolate, so a suite that leaves a Durable Object name live
    // sees it from the next file; every suite here mints its own names.
    isolate: false,
    // No per-test clock: every wait in these suites ends on its condition or on
    // the runtime's own terminal signal, and a hang is killed by the deploy
    // ladder at the gate's deadline, which names the gate. `0` is Vitest's
    // documented disabled-timeout value; `gate:test-clocks` pins it.
    //
    // THE COLD START `0` IS CHOSEN AGAINST, measured on this tree 2026-09-16
    // (vitest 4.1.11, single-file runs, warm module cache, this box): the FIRST
    // test in a file pays the pool boot and the bundle's instantiation inside
    // its own body — 12,603 ms in `do-alarm.test.ts`, 7,408 ms in
    // `do-transaction.test.ts` — while a steady-state test in the same file
    // costs 3 ms, and a trivial file still spends ~13 s in vitest's `import`
    // phase plus ~4.5 s transforming and ~3.7 s building the probe bundles this
    // config compiles. Vitest's default 5,000 ms would fail the first test of
    // both files here, so any finite clock is a bet on the runner's load.
    // With `isolate: false` above only a row's FIRST file pays that boot;
    // the bet on load is the same.
    testTimeout: 0,
    hookTimeout: 0,
    // The rejections this layer's probes raise ON PURPOSE, each with its reason,
    // and nothing else: an unhandled error no line here names stays fatal.
    //
    // WHICH CHANNEL CARRIES THEM, measured 2026-09-16 on this tree: a rejection
    // nobody awaits in the TEST isolate reaches this hook and fails the run even
    // when every test passed (scratch-proved), while a rejection raised inside a
    // Durable Object — both entries below — is printed by workerd as
    // `uncaught exception; source = Uncaught (in promise)` and does not reach
    // this hook yet. The entries are written against the message anyway, because
    // the POOL decides which channel carries a DO-side rejection: the owner's
    // cloudflare-os pool routes them here, and one pool upgrade would otherwise
    // turn two deliberate probe arms into a red layer.
    onUnhandledError(error) {
      // `AlarmDO.alarm` rethrows so the RUNTIME owns redelivery, which is the
      // subject `do-alarm.test.ts` asserts; nothing awaits that delivery
      // (worker.ts:503-506).
      if (error.message.includes('alarm-body-failed')) return false;

      // `TransactionDO` fails the roster write after the event row landed —
      // the rollback `do-transaction.test.ts` asserts — and its async-body arm
      // throws after `transactionSync` already committed, so that promise has
      // no owner left (worker.ts:258, :289).
      if (error.message.includes('unknown subordinate "relay"')) return false;

      // `deploy-ledger.test.ts` aborts a DeployRunDO in the middle of its
      // plan — the eviction a run cannot control, delivered on purpose — and
      // the call the object had in flight at that moment rejects with the
      // abort reason, owned by nobody.
      if (error.message.includes('probe: the object died mid-plan')) return false;
    },
  },
});
