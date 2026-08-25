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
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
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
