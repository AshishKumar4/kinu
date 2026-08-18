// Every test process gets a throwaway PROTEUS_HOME, and one release that runs.
//
// `proteusHome()` falls back to `~/.proteus`, and a test that drives the local
// runtime writes there for real: `createCLIRuntime` builds a shadow-git
// checkpoint engine rooted at `$PROTEUS_HOME/checkpoints`, and every /pc or
// /workspace write snapshots into it. That is how packages/cli-backend/tests/
// mount-plane.test.ts put ~580 checkpoint stores — keyed by its own /tmp scratch
// directories — into the developer's real home.
//
// Setting it per suite would be one more thing to remember in each of the eleven
// test files that build a runtime, so it is set once, here, for every test
// process. Tests that need the fallback still delete the variable themselves.
//
// WHY THIS MODULE IS SEPARATE FROM THE HOOK. Two runners load it: `bun test` via
// `bunfig.toml`'s `preload`, and vitest via `vitest.evals.config.ts`'s
// `setupFiles` (the behavioural eval tier runs on vitest because the spine under
// test reaches `bun:sqlite`). Their `afterAll` are different functions from
// different modules, and calling `bun:test`'s under vitest throws `Cannot use
// afterAll() outside of the test runner` — the eval tier then fails at
// COLLECTION with no tests and one failed suite, which is how it blocked a
// production deploy. So the logic lives here, imported statically by a
// three-line entry per runner, each importing the `afterAll` that belongs to it.
// The alternative — one file choosing a runner at runtime — would either load
// vitest into every `bun test` process or sniff an environment variable that
// vitest is free to rename, and a teardown that silently registers with the
// wrong runner is the failure this module exists to prevent.
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseScratch } from '../packages/test-utils/src/scratch';

const home = mkdtempSync(join(tmpdir(), 'proteus-test-home-'));
process.env.PROTEUS_HOME = home;

/**
 * The ONE release, registered by each runner's entry as an `afterAll`.
 *
 * Which hook took three probes with filesystem markers to establish.
 * `process.on('exit')` does NOT fire under `bun test` (nor does `beforeExit`) —
 * the preload claimed it did, and consequently stranded one
 * `proteus-test-home-*` per invocation on the PLAIN PASSING PATH: 274 of them on
 * this box, which the stale sweeper below then quietly absorbed. An `afterAll`
 * registered in a preload applies to every test file in the invocation, fires
 * once at the end, and fires even when a file failed — measured across a
 * two-file probe with one passing and one failing file, both scratch directories
 * removed.
 *
 * It also releases what suites minted through `scratchDir` (test-utils
 * src/scratch.ts), so no suite has to remember an afterEach for the same
 * property. Deep-imported rather than taken from the package index: this module
 * is loaded into every test process and has no business pulling that graph in.
 */
export const release = (): void => {
  releaseScratch();
  rmSync(home, { recursive: true, force: true });
};

// The signal path stays: it is the `timeout <n> bun test` case that every agent
// and CI step runs under, whose default kill is SIGTERM, and a runner that
// reported success for a killed suite would be worse than the leak — so the
// listener releases, deregisters itself, and re-raises the default disposition
// rather than swallowing the signal. SIGKILL remains uncatchable by definition;
// `scripts/preflight.ts --reclaim` is the backstop for that.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    release();
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}

// The SIGKILL backstop, and only that. It used to carry the whole leak: the
// `afterAll` did not exist, `exit` never fires under this runner, so the plain
// passing path stranded a home every invocation and this sweep was what made
// that survivable — a self-heal standing in for a release. With the release in
// place this is what it always claimed to be: the case where no JS can run.
//
// Measured, when it was load-bearing: 3,655 stranded directories took /tmp to
// 100% of its INODES while 8 GB of bytes were still free, and `mkdtemp` then
// failed so `bun test` died before collecting a single test — an environment
// fault that reads as a code defect in whatever change happened to be under
// test.
//
// The bound is 30 minutes against a `timeout 600` ceiling, which is 3x headroom;
// the cost is one readdir plus a stat per entry. It covers the suite-minted
// `proteus-scratch-*` namespace too, for the same reason and by the same rule.
const STALE_HOME_MS = 30 * 60 * 1000;
const cutoff = Date.now() - STALE_HOME_MS;
const tmp = tmpdir();
const ABANDONED = ['proteus-test-home-', 'proteus-scratch-'] as const;
for (const name of readdirSync(tmp)) {
  if (!ABANDONED.some((prefix) => name.startsWith(prefix)) || join(tmp, name) === home) continue;
  const path = join(tmp, name);
  // A racing peer may remove it between the stat and the rm; `force` covers
  // that. Anything else — a permission fault, a path that is not ours — must
  // surface rather than be swallowed into a silently growing directory.
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat === undefined || stat.mtimeMs >= cutoff) continue;
  rmSync(path, { recursive: true, force: true });
}
