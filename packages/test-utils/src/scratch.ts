/**
 * The one place a suite mints a temp directory, and the one place they are
 * collected from.
 *
 * The leak this exists to end, measured 2026-08-17: 8,643 `/tmp/kinu-*`
 * entries on a developer box after one evening, rising monotonically as suites
 * ran, and `scripts/preflight.ts` could see only 6,102 of them because its
 * prefix catalogue was a hand-written list that every new suite silently grew
 * past. Its own comment already named the failure mode — a prefix missing from
 * the catalogue is "simultaneously uncollected and invisible" — and then the
 * catalogue drifted anyway: `kinu-scaffold-test-`, `kinu-runtimes-`,
 * `kinu-webhook-`, `kinu-vfs-`, `kinu-gepa-`, `kinu-codex-auth-`,
 * `kinu-shared-` and `kinu-mcp-test-` were all minted in-repo and none of
 * them were listed.
 *
 * So ownership is structural here rather than clerical:
 *
 *   1. ONE NAMESPACE. `scratchDir('mount-plane')` mints
 *      `kinu-scratch-mount-plane-XXXXXX`, so `kinu-scratch-` alone
 *      identifies every directory any suite minted through this module, and the
 *      LABEL says which suite minted it — which the old
 *      `/tmp/kinu-test-63938` never did, and that is why nobody could
 *      attribute the leak while watching the number rise.
 *   2. ONE RELEASE, in the one place that runs. `scripts/test-preload.ts` is
 *      preloaded into every `bun test` process and registers a `bun:test`
 *      `afterAll` that calls {@link releaseScratch}, so a suite does not have to
 *      remember anything and a FAILING file's scratch is still removed
 *      (measured: both, plus the failing case). What does NOT work, measured
 *      three ways, is `process.on('exit')` — bun's test runner never reaches it,
 *      so anything hung on it is a leak with a nicer name: the cleanup is
 *      claimed and never runs, one stranded KINU_HOME per invocation. Past
 *      SIGKILL nothing can run, and `scripts/preflight.ts --reclaim` stays the
 *      backstop for that.
 *   3. ONE CATALOGUE, read by the collector. `scripts/preflight.ts` imports
 *      {@link SCRATCH_PREFIXES} instead of keeping its own copy, so counting and
 *      reclaiming cannot disagree with minting about what is ours.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Prefixes under the temp directory that belong to THIS project's test and gate
 * runs. Read by `scripts/preflight.ts` for both the count it reports and the
 * `--reclaim` it offers, so anything absent here is invisible to the instrument
 * and never collected.
 *
 * `kinu-` is deliberately coarse: it covers `kinu-scratch-` and every
 * pre-existing suite-specific name in one entry, because a `/tmp/kinu-*`
 * directory on any box running this repo is ours by construction and a list of
 * sixty exact spellings is the thing that already drifted. The rest are the
 * gate and harness names that do not carry the project prefix — a fixed set,
 * checked by `scripts/scratch-ownership.ts` against what the repo actually
 * mints.
 *
 * What makes that coarseness safe is an invariant that has to stay true:
 * EVIDENCE IS NEVER MINTED UNDER A SCRATCH PREFIX. `--reclaim` removes anything
 * matching these, so a retained artifact — a bench trial, an eval transcript, a
 * captured run — must live somewhere else, and it does: `resolveArtifactRoot`
 * refuses the temp directory outright for exactly this reason. Checked against
 * the 43 paths peers were relying on the night this was written: none of them
 * begins with any prefix here.
 */
export const SCRATCH_PREFIXES = [
  'kinu-',
  'agent-core-',
  'capture-probe-',
  'devbox-digest-',
  // The devbox bench-decision suite's control fixtures.
  'devbox-control-',
  'fuse-probe-',
  'bench-external-',
  'cc-corpus-',
  'deploy-isolation-',
  'dist-integrity-',
  'harness-wiring-',
  // Not ours, but created BECAUSE a suite of ours ran: the `opencode` CLI makes
  // an empty `$TMPDIR/opencode` when local-session.test.ts resolves models
  // through it. Catalogued so preflight can see and collect it — an entry it
  // cannot name is an entry nobody counts, which is the whole lesson of this
  // list. Releasing it is not ours to do; ageing it out is.
  'opencode',
  'mutation-gate-',
  'nimbus-probe-',
  // The pc-agent supervisor suites: one coarse family entry, the same rule as
  // `kinu-` — eleven exact spellings is the list that drifts.
  'pc-agent-',
  // The anti-slop gates' oxlint fixture prefixes. Each gate mints under tmpdir() and
  // releases in its own finally, so the only survivor is a SIGKILLed run — exactly the
  // case this catalogue exists to make visible to preflight's count and --reclaim.
  'no-ambient-git-boundary-',
  'no-ambient-git-gate-',
  'no-copy-rpc-stub-gate-',
  'no-swallow-gate-',
  'no-wait-until-gate-',
  'return-await-gate-',
  'typescript-escapes-gate-',
  'no-deep-import-gate-',
  'outcome-baseline-',
  'pi-worker-test-',
] as const;

/** The namespace every directory minted through {@link scratchDir} carries. */
export const SCRATCH_ROOT_PREFIX = 'kinu-scratch-';

/** Directories this process minted and still owns. */
const minted = new Set<string>();

/** One thing this process backgrounded, and the call that lets it go. */
interface Hold {
  readonly label: string;
  readonly release: () => void;
}

/** What this process backgrounded and still owns. Records rather than labels:
 *  two calls of one harness hold two browsers, and a second registration must
 *  not displace the first. */
const holds = new Set<Hold>();

/**
 * Own something this run BACKGROUNDED until the run ends: a browser holding a
 * profile inside a scratch root, a dev server holding a socket. Returns the
 * drop, for a caller that tore its own down.
 *
 * This is the seam the `survived rmSync` error below asks for. "Stop what the
 * suite backgrounded before the run ends" was a sentence with nothing behind
 * it, and on a KILLED run there was no way to act on it at all: the preload's
 * signal listener releases and then ends the process inside its own re-raise,
 * so a listener registered after it — every suite's and every harness's — is
 * never reached (measured 2026-09-17 on bun 1.4.0: a second SIGTERM listener
 * did not run, and eleven chrome processes outlived the row). A hold runs on
 * every path that release does, which is the one path there is.
 *
 * The label is what a failure is attributable by, for the same reason a
 * scratch root carries one.
 */
export function holdForRelease(label: string, release: () => void): () => void {
  const hold: Hold = { label, release };

  holds.add(hold);

  return () => { holds.delete(hold); };
}

/**
 * Remove everything this run minted, and SAY SO when a removal did not happen.
 *
 * `rmSync(force: true)` swallows ENOENT, which is what makes a racing peer's
 * removal harmless — and it also swallows ENOTEMPTY, which is not harmless at
 * all: measured in `packages/cli/tests/exec-process-lifecycle.test.ts`, a
 * backgrounded writer reopening its log every second beat the unlink, the rmdir
 * failed, `force` ate the error, and `rmSync` RETURNED SUCCESS while the
 * directory survived with the same inode. Two homes leaked that way per run and
 * nothing reported it. So this checks, and a directory still standing after its
 * own removal is an error naming the one thing that causes it.
 *
 * Every root is attempted even when one fails — a refused `rmSync` or a
 * surviving directory is collected, not thrown on the spot, so one bad root
 * cannot shield the rest of the mint set. The failures come back in ONE
 * `AggregateError` under `scratch not released`, each carrying its original
 * cause, and only a root that is provably gone leaves ownership: the failed
 * ones stay minted for an explicit later release.
 *
 * What the run BACKGROUNDED goes first ({@link holdForRelease}). A process
 * still writing into a scratch root is what makes `rmSync` report success over
 * a surviving directory, and once the directory is gone there is nothing left
 * to tell it to stop.
 */
export function releaseScratch(): number {
  let removed = 0;
  const held: Error[] = [];

  for (const hold of [...holds].reverse()) {
    holds.delete(hold);

    try {
      hold.release();
    } catch (cause) {
      held.push(new Error(`${hold.label}: the hold refused to release`, { cause }));
    }
  }

  // Every owned root is ATTEMPTED even when one fails, children before their
  // parents (reverse mint order): a nested root minted inside another root is
  // addressed first, so a surviving parent is not blamed for a child that
  // already went, and one bad root never shields another.
  for (const dir of [...minted].reverse()) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (cause) {
      held.push(new Error(`${dir}: rmSync refused`, { cause }));
      continue;
    }

    if (existsSync(dir)) {
      held.push(new Error(
        `${dir} survived rmSync, which reports success when a live process is `
        + 'still writing into the tree. Stop what the suite backgrounded '
        + 'before the run ends.',
        { cause: { leftovers: readdirSync(dir, { recursive: true }) } },
      ));
      continue;
    }

    // Only a root that is provably gone leaves ownership: a failed one stays
    // minted, so an explicit later releaseScratch still attempts it.
    minted.delete(dir);
    removed += 1;
  }

  if (held.length > 0) {
    // bun's reporter prints the AggregateError's message but drops each held
    // error's cause; the leftovers are written where the run log can name them.
    // process.env.TMPDIR points inside a scratch root this release may have
    // just removed, so the report lands in the OS tmpdir by construction.
    const report = join('/tmp', 'kinu-scratch-held.json');

    writeFileSync(
      report,
      JSON.stringify(held.map((e) => ({ message: e.message, cause: e.cause })), null, 2),
    );

    throw new AggregateError(
      held,
      `scratch not released: ${held.length} owned root(s) failed removal and stay owned for a later release (leftovers in ${report})`,
    );
  }

  return removed;
}

/**
 * A fresh temp directory owned by this run, removed when the run ends.
 *
 * `label` names the suite or fixture, appears in the directory name, and is the
 * whole diagnostic: a leak that outlives the run is attributable to a file by
 * reading the temp directory, instead of being 5,489 identical numbers.
 * `parent` lets repository-local fixture programs resolve their dependencies.
 *
 * Registration of the release is the PRELOAD's job (`scripts/test-preload.ts`),
 * and that is not a style choice — it is the only mechanism measured to run.
 * Under `bun test` 1.3.14 a `process.on('exit')` handler NEVER fires, and
 * neither does `beforeExit`: three independent probes with filesystem markers
 * (a marker cannot be swallowed the way stdout at exit can) showed the handler
 * body never running while the same code under `bun run` released correctly. A
 * `bun:test` `afterAll` registered in the preload DOES run, once per
 * invocation, and runs even when a test file failed — which is the property
 * this whole module exists to provide. The same measurement explains a leak
 * nobody had attributed: `test-preload` claimed `exit` covered its throwaway
 * KINU_HOME, so it stranded one per `bun test` invocation, 274 of them on
 * this box, and its 30-minute stale sweeper was that leak being papered over.
 */
export function scratchDir(label: string, parent = tmpdir()): string {
  const dir = mkdtempSync(join(parent, `${SCRATCH_ROOT_PREFIX}${label}-`));
  minted.add(dir);

  return dir;
}

/**
 * A path INSIDE a fresh scratch directory — for the callers that need a file
 * that does not exist yet, `dbPath` above all. Hand-rolling this as
 * `/tmp/kinu-test-${performance.now()}.db` is what put 5,489 directories in
 * `/tmp`: the name was unique, unowned, and unattributable.
 */
export function scratchPath(label: string, name: string): string {
  return join(scratchDir(label), name);
}
