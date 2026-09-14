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

const slateDurabilityProbe = buildSync({
  entryPoints: [fileURLToPath(new URL('./tests/workerd/slate-durability-probe.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./tests/workerd/.compiled/slate-durability-probe.js', import.meta.url)),
  bundle: true, write: false, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser'], target: 'es2022',
  alias: { 'virtual:kinu-slate-vendor': slateVendorModulePath, ...Object.fromEntries(builtinModules.filter((name) => !name.startsWith('node:')).map((name) => [name, 'node:' + name])) },
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
        // The dynamic-Worker loader `execute_tools` runs programs through
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
          durableObjects: {
            SLATE_DURABILITY_PROBE: { className: 'SlateDurabilityProbeRoot', useSQLite: true },
            OrchestratorAgent: { className: 'OrchestratorAgent', useSQLite: true },
            UserDO: { className: 'UserDO', useSQLite: true },
          },
        }],
        durableObjects: {
          RETENTION: { className: 'RetentionDO', useSQLite: true },
          NEIGHBOUR: { className: 'NeighbourDO', useSQLite: true },
          GATED: { className: 'GatedDO', useSQLite: true },
          TRANSACTION: { className: 'TransactionDO', useSQLite: true },
          SOCKET: { className: 'SocketDO', useSQLite: true },
          ALARMED: { className: 'AlarmDO', useSQLite: true },
          STEER_PROBE: { className: 'SteerProbeDO', useSQLite: true },
          EVICTION_PROBE: { className: 'EvictionProbeDO', useSQLite: true },
          WITNESS: { className: 'WitnessDO', useSQLite: true },
          CAPPED_TURN_PROBE: { className: 'CappedTurnProbeDO', useSQLite: true },
          UNBOUNDED_TURN_PROBE: { className: 'UnboundedTurnProbeDO', useSQLite: true },
          SPEND_PROBE: { className: 'SpendProbeDO', useSQLite: true },
          TERMINAL_EFFECT_PROBE: { className: 'TerminalEffectProbeDO', useSQLite: true },
          DB_CAPABILITY_PROBE: { className: 'DbCapabilityProbeDO', useSQLite: true },
          FIBER_RECOVERY_PROBE: { className: 'FiberRecoveryProbeAgent', useSQLite: true },
          FORK_SOURCE: { className: 'ForkSourceProbeDO', useSQLite: true },
          FORK_TARGET: { className: 'ForkTargetProbeDO', useSQLite: true },
          STREAM_LIFECYCLE: { className: 'StreamLifecycleDO', useSQLite: true },
          SEND_ADMISSION_PROBE: { className: 'SendAdmissionProbeDO', useSQLite: true },
          FILES_EIO_PROBE: { className: 'FilesEioProbeDO', useSQLite: true },
          PREVIEW_PORT_PROBE: { className: 'PreviewPortProbeDO', scriptName: 'hosted-preview-probe', useSQLite: true },
          SLATE_PROCESS_PROBE: { className: 'SlateProcessProbeDO', useSQLite: true },
          SLATE_ACTOR_ROOT: { className: 'SlateActorProbeRoot', scriptName: 'slate-actor-probe', useSQLite: true },
          PLAN_ANNOUNCE_ROOT: { className: 'OrchestratorAgent', scriptName: 'plan-announce-probe', useSQLite: true },
          USER_SOCKET_PROBE: { className: 'UserSocketProbeDO', scriptName: 'plan-announce-probe', useSQLite: true },
          SLATE_EGRESS_PROBE: { className: 'SlateEgressProbe', scriptName: 'slate-egress-probe', useSQLite: true },
          DEVICE_LEDGER_PROBE: { className: 'DeviceLedgerProbeDO', useSQLite: true },
          TWO_TURN_PROBE: { className: 'TwoTurnProbeRoot', scriptName: 'two-turn-probe', useSQLite: true },
          DEVBOX_NOT_READY_PROBE: { className: 'DevboxNotReadyProbeDO', useSQLite: true },
          SLATE_DURABILITY_PROBE: { className: 'SlateDurabilityProbeRoot', scriptName: 'slate-durability-probe', useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ['tests/workerd/**/*.test.ts'],
    // These tests measure gates and cancellation windows in wall time. Vitest's
    // default per-file parallelism would have two of them contend for the same
    // runtime and turn a latency assertion into a flake.
    fileParallelism: false,
    // Condition-bound diagnostic deadlines have to expire INSIDE the test so the
    // assertion can name the state actually reached: steer-chain waits 15s for a
    // client frame, and do-eviction-recovery waits 90s for chat recovery, which
    // the SDK schedules on the object's own alarm with backoff rather than
    // immediately. A passing run spends neither — every wait stops at its
    // condition.
    testTimeout: 120_000,
  },
});
