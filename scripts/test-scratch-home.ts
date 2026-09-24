// Every test process gets a throwaway KINU_HOME, no inherited credentials,
// and one release that runs.
//
// `kinuHome()` falls back to `~/.kinu`, and a test that drives the local
// runtime writes there for real: `createCLIRuntime` builds a shadow-git
// checkpoint engine rooted at `$KINU_HOME/checkpoints`, and every /pc or
// /workspace write snapshots into it. That is how packages/cli-backend/tests/
// mount-plane.test.ts put ~580 checkpoint stores — keyed by its own /tmp scratch
// directories — into the developer's real home.
//
// Setting it per suite would be one more thing to remember in each of the eleven
// test files that build a runtime, so it is set once, here, for every test
// process. Tests that need the fallback still delete the variable themselves.
//
// WHY THIS MODULE IS SEPARATE FROM THE HOOK. Two runners load it: `bun test` via
// `bunfig.toml`'s `preload`, and vitest via the `setupFiles` of
// `evals/vitest.config.ts` and `vitest.first-run.config.ts`. Their `afterAll` are
// different functions from different modules, and calling `bun:test`'s under
// vitest throws `Cannot use afterAll() outside of the test runner` — a vitest
// tier then fails at
// COLLECTION with no tests and one failed suite, which is how it blocked a
// production deploy. So the logic lives here, imported statically by a
// three-line entry per runner, each importing the `afterAll` that belongs to it.
// The alternative — one file choosing a runner at runtime — would either load
// vitest into every `bun test` process or sniff an environment variable that
// vitest is free to rename, and a teardown that silently registers with the
// wrong runner is the failure this module exists to prevent.
import { tolerate } from '@kinu.run/core/obs';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { releaseOnSignals, releaseScratch, SCRATCH_ROOT_PREFIX, scratchDir } from '../packages/test-utils/src/scratch';
import { stripAmbientCredentials } from '../packages/test-utils/src/ambient-env';
import { currentOwner, ownerAlive, ProcessOwnerSchema } from './process-owner';

const tmp = tmpdir();

// Minted through the same owner every suite uses, so `release` needs no
// lifecycle of its own: `releaseScratch` removes this root along with
// everything else this process owns, and a partial failure stays owned.
const scratchRoot = scratchDir('test-home', tmp);

/** Who minted a root, so a later run judges it by whether that process still runs (below). */
const OWNER_RECORD = 'owner.json';

const owner = currentOwner();

if (owner !== null) writeFileSync(join(scratchRoot, OWNER_RECORD), JSON.stringify(owner));

const home = join(scratchRoot, 'home');

mkdirSync(home);

process.env.KINU_HOME = home;

// Child processes inherit a temporary directory owned by this same invocation.
process.env.TMPDIR = scratchRoot;

// The daemon captures this path on its first require, before a later suite can set it.
process.env.KINU_INFLIGHT_ROOT = join(home, 'inflight');

// The throwaway home isolates a suite from the developer's CONFIG FILE. This is
// the same property for the ENVIRONMENT, which was the half nobody had done:
// `resolveCloudSession()` prefers `KINU_TOKEN` over that config file, so a
// shell that had run `bun run test:live` or `kinu chat` silently moved ten of
// `bun test packages/cli/`'s tests onto their signed-in branch and left them
// red. See packages/test-utils/src/ambient-env.ts for the measurement.
//
// KINU_EVAL_LIVE=1 is the exception because it is already the consent
// boundary for the tiers that mean to use these variables: scripts/live-tier.sh
// and scripts/first-run-tier.sh set it, nothing else does, and
// `liveModelTarget()` refuses to spend without it. One rule, not two.
//
// It says so rather than doing it quietly — a developer whose shell is signed in
// should not have to infer why their credential is not in play.
if (process.env.KINU_EVAL_LIVE !== '1') {
  // By name, never `process.env` as a value: see `EnvByName`.
  const ignored = stripAmbientCredentials({
    has: (name) => process.env[name] !== undefined,
    remove: (name) => { delete process.env[name]; },
  });

  if (ignored.length > 0) {
    console.warn(`[test-preload] ignoring ambient ${ignored.join(', ')} — a signed-in shell is `
      + 'not an input to a suite; run the live tier (KINU_EVAL_LIVE=1) to use them');
  }
}

/**
 * The ONE release, registered by each runner's entry as an `afterAll`.
 *
 * Which hook took three probes with filesystem markers to establish.
 * `process.on('exit')` does NOT fire under `bun test` (nor does `beforeExit`) —
 * the preload claimed it did, and consequently stranded one
 * `kinu-test-home-*` per invocation on the PLAIN PASSING PATH: 274 of them on
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
  // The runner's own root is minted through scratchDir above, so this is the
  // whole release: every owned root attempted, failures reported and retained.
  releaseScratch();
};

// The signal path stays: it is the `timeout <n> bun test` case that every agent
// and CI step runs under, and a runner that reported success for a killed suite
// would be worse than the leak.
releaseOnSignals();

// The SIGKILL backstop, and only that: the runner's `afterAll` and the signal
// listeners above release on every path JS can reach, so what is left here is
// the case where no JS can run.
//
// Measured: 3,655 stranded directories took /tmp to 100% of its INODES while
// 8 GB of bytes were still free, and `mkdtemp` then failed so `bun test` died
// before collecting a single test — an environment fault that reads as a code
// defect in whatever change happened to be under test.
//
// A root is abandoned when the process that minted it no longer runs, which its
// owner record says (process-owner.ts: boot, pid and start tick, so a reused pid
// is not the owner). Age said nothing: an eval episode runs 30 minutes by design
// and an eval tier for hours, and the 30-minute bound this replaced reaped live
// roots out from under them. A root with no readable record (minted before
// records existed, or killed mid-write) is left to `scripts/preflight.ts
// --reclaim` rather than guessed at.
/** Remove every scratch root under `parent` whose recorded owner has ended; `keep` is this run's own. */
export function reapAbandonedRoots(parent: string, keep: string): string[] {
  const reaped: string[] = [];

  for (const name of readdirSync(parent)) {
    const path = join(parent, name);

    if (!name.startsWith(SCRATCH_ROOT_PREFIX) || path === keep) continue;

    // A root is a directory; `kinu-scratch-held.json`, the release report, shares the prefix.
    if (statSync(path, { throwIfNoEntry: false })?.isDirectory() !== true) continue;
    // Absent, or taken by a racing peer: nothing to judge.
    const text = tolerate(() => readFileSync(join(path, OWNER_RECORD), 'utf8'), 'enoent');
    const recorded = text === undefined ? undefined : v.safeParse(v.pipe(v.string(), v.parseJson(), ProcessOwnerSchema), text);

    if (!recorded?.success || ownerAlive(recorded.output)) continue;
    // A racing peer may remove it between the read and the rm; `force` covers that.
    rmSync(path, { recursive: true, force: true });
    reaped.push(path);
  }

  return reaped;
}

reapAbandonedRoots(tmp, scratchRoot);
