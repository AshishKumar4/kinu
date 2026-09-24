/**
 * The one place suites mint and release temp directories: all under `kinu-scratch-<label>-`, released by the
 * `afterAll` in `scripts/test-preload.ts`, with {@link SCRATCH_PREFIXES} read by `scripts/preflight.ts`.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Temp-dir prefixes owned by this project, counted and `--reclaim`ed by `scripts/preflight.ts`; checked by
 * `scripts/scratch-ownership.ts`. Invariant: evidence is never minted under these (`resolveArtifactRoot` refuses tmpdir).
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
  // Not ours: the `opencode` CLI creates `$TMPDIR/opencode` when local-session.test.ts resolves models; listed so preflight ages it out.
  'opencode',
  'mutation-gate-',
  'nimbus-probe-',
  // pc-agent supervisor suites, one coarse family entry.
  'pc-agent-',
  // Anti-slop gates' oxlint fixtures; only a SIGKILLed run leaves them behind.
  'no-ambient-git-boundary-',
  'no-ambient-git-gate-',
  'no-copy-rpc-stub-gate-',
  'no-swallow-gate-',
  'no-wait-until-gate-',
  'typescript-escapes-gate-',
  'no-deep-import-gate-',
  'no-design-smells-gate-',
  'type-aware-gate-',
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

/** Records rather than labels: two registrations of one harness must not displace each other. */
const holds = new Set<Hold>();

/**
 * Own something this run backgrounded (browser, dev server) until release; returns the drop. Needed because the
 * preload's signal handler exits inside its re-raise, so later SIGTERM listeners never run (measured 2026-09-17, bun 1.4.0).
 */
export function holdForRelease(label: string, release: () => void): () => void {
  const hold: Hold = { label, release };

  holds.add(hold);

  return () => { holds.delete(hold); };
}

/**
 * Remove everything this run minted, holds first. Verifies each root is gone, since `rmSync(force)` can report
 * success over a surviving dir (ENOTEMPTY from a live writer). Failures return as one `AggregateError` and stay owned.
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

  // Reverse mint order: children before parents; every root is attempted.
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

    minted.delete(dir);
    removed += 1;
  }

  if (held.length > 0) {
    // bun's reporter drops each held error's cause, so leftovers go to the OS tmpdir
    // (process.env.TMPDIR may be inside a root just removed).
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

/** Release on SIGTERM, SIGINT and SIGHUP, then re-raise so a killed run reads as killed. */
export function releaseOnSignals(): void {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => {
      releaseScratch();
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
}

/**
 * A fresh temp directory named by `label`, removed when the run ends; `parent` lets repo-local fixtures resolve deps.
 * Release is registered by the preload's `afterAll`: under `bun test` 1.3.14 `process.on('exit')`/`beforeExit` never fire.
 */
export function scratchDir(label: string, parent = tmpdir()): string {
  const dir = mkdtempSync(join(parent, `${SCRATCH_ROOT_PREFIX}${label}-`));
  minted.add(dir);

  return dir;
}

/** A path inside a fresh scratch directory, e.g. for `dbPath`. */
export function scratchPath(label: string, name: string): string {
  return join(scratchDir(label), name);
}
