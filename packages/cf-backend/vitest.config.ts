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
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { transform } from 'esbuild';
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * `@callable()` is a TC39 standard decorator, and Vite 8 transforms TypeScript
 * with oxc, whose only decorator support is the LEGACY (pre-standard) form. On a
 * decorated module oxc strips the types and emits the `@` unchanged, so the
 * module reaches the runtime as `SyntaxError: Invalid or unexpected token`. That
 * is why this layer hosted only undecorated probe classes and could not load a
 * production Agent: not a charter decision, a transform gap. KINU-065.
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

export default defineConfig({
  plugins: [
    standardDecorators(),
    cloudflareTest({
      main: './tests/workerd/worker.ts',
      miniflare: {
        compatibilityDate: '2025-12-01',
        compatibilityFlags: ['nodejs_compat'],
        // `new_sqlite_classes` in wrangler.jsonc:100-115 is what production
        // registers these under; miniflare spells the same thing `useSQLite`.
        // Without it `ctx.storage.sql` throws and the init-gate read would
        // measure an error path instead of the gate.
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
          FIBER_RECOVERY_PROBE: { className: 'FiberRecoveryProbeAgent', useSQLite: true },
          FORK_SOURCE: { className: 'ForkSourceProbeDO', useSQLite: true },
          FORK_TARGET: { className: 'ForkTargetProbeDO', useSQLite: true },
          STREAM_LIFECYCLE: { className: 'StreamLifecycleDO', useSQLite: true },
          SEND_ADMISSION_PROBE: { className: 'SendAdmissionProbeDO', useSQLite: true },
          DEVICE_LEDGER_PROBE: { className: 'DeviceLedgerProbeDO', useSQLite: true },
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
