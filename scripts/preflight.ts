/**
 * The environment invariants every other gate silently assumes.
 *
 * This exists because of a measured incident, not a hypothesis. On 2026-08-17
 * deploy gate 6 (the cli-backend suite, then spelled `--cwd packages/cli-backend`)
 * went red at HEAD 5183d69d, reproducibly, in a clean worktree. The message the
 * ladder printed was:
 *
 *     (fail) the laptop executor reads and writes the real host filesystem
 *       ^ this test timed out after 5000ms.
 *
 * which names nothing, points at a filesystem test, and blames whatever change
 * was under review. The actual chain was three steps away from that line: a
 * sibling stream had left a `package.json` in `/tmp`; `workdirForPath` walks
 * ancestors looking for generic project markers and stops only at `/` and
 * `$HOME`, so it resolved the checkpoint working directory for every temp-dir
 * host write to `/tmp` itself; the first `laptop.writeFile` therefore
 * shadow-git-added a 23 GB tmpfs, measured at 24,483 ms against a 5,000 ms
 * per-test limit. Meanwhile the same tmpfs was at 1,048,576 of 1,048,576
 * inodes, and 541,319 of those belonged to our own leaked test scratch.
 *
 * Every gate downstream of that was reporting on an environment nobody had
 * looked at. So this runs first in every tier, costs milliseconds, and names
 * the cause instead of letting it surface as an unrelated timeout.
 *
 * It deliberately does NOT repair anything. A gate that quietly fixes its own
 * precondition teaches nobody and hides a leak that will come back.
 */

import { existsSync, readFileSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { assertMeasured, finding } from './gate-ratchet';
import { SCRATCH_PREFIXES } from '@kinu.run/test-utils';

/** This checkout, so the merge-state probe reads THIS tree's git directory
 *  rather than whatever directory the gate happened to be invoked from. */
const repo = new URL('..', import.meta.url).pathname;

/**
 * What one full suite sweep costs the temp filesystem.
 *
 * MEASURED 2026-08-17 with `TMPDIR` pointed at a private directory (so nothing
 * another process does is attributed here) and `du --inodes` polled at 0.3s
 * across `bun run test` plus every per-package gate plus `bun run test:workerd`:
 * a peak of 3,968 inodes and 22.3 MiB, leaving 2,079 inodes of residue behind
 * after the sweep finished — homes whose suite did not reach the `exit`
 * handler, which is what `--reclaim` is for.
 *
 * The previous comment here read "444 test processes, each given a throwaway
 * KINU_HOME by scripts/test-preload.ts". That was FALSE at the time it was
 * written: `bun test --cwd <dir>` makes bun load a bunfig.toml from THAT
 * directory, so the root one — and its `preload` — never applied, and every
 * per-package gate ran with no throwaway home at all. A probe printed
 * `KINU_HOME= undefined` under `--cwd` and a real temp path root-relative.
 * Every gate string is root-relative now, so the sentence is true and the
 * measurement above is of the system it describes.
 *
 * The budget stays well above the measured peak on purpose and the floors below
 * are NOT lowered to match it: the measurement is one sweep alone on the box,
 * and the failure this gate exists for happened with several agents running
 * suites at once — one CI-tier run reported 12,591 temp entries, 7,016 of them
 * leaked test scratch. A floor derived from a quiet box would not have caught
 * that.
 */
const MEASURED_INODES_PER_RUN = 3_968 + 2_079;
const INODES_PER_FULL_RUN = 24_000;
const BYTES_PER_FULL_RUN = 1024 * 1024 * 1024;

if (INODES_PER_FULL_RUN < MEASURED_INODES_PER_RUN) {
  throw new Error(
    `preflight: INODES_PER_FULL_RUN (${String(INODES_PER_FULL_RUN)}) is below what one `
    + `sweep was measured to cost (${String(MEASURED_INODES_PER_RUN)}). Re-measure before `
    + 'lowering it — the budget is a margin over a measurement, not a guess.',
  );
}

/**
 * Two runs' worth of headroom, so the floor is crossed while a legible message
 * is still possible rather than at the moment a random test hits ENOSPC.
 *
 * The relationship is asserted rather than the literal. A future change that
 * lowers the floor below what two runs consume fails here, at the definition,
 * naming why the number exists — which is the difference between a threshold
 * and a number in a diff nobody reads.
 */
const MIN_FREE_INODES = 60_000;
const MIN_FREE_BYTES = 3 * BYTES_PER_FULL_RUN;

if (MIN_FREE_INODES < 2 * INODES_PER_FULL_RUN) {
  throw new Error(
    `preflight: MIN_FREE_INODES (${String(MIN_FREE_INODES)}) is below two full suite runs `
    + `(2 × ${String(INODES_PER_FULL_RUN)}). The floor exists so the suite fails with a `
    + 'reason instead of with ENOSPC in an unrelated test; lowering it defeats the check.',
  );
}
if (MIN_FREE_BYTES < 2 * BYTES_PER_FULL_RUN) {
  throw new Error(
    `preflight: MIN_FREE_BYTES (${String(MIN_FREE_BYTES)}) is below two full suite runs.`,
  );
}

/**
 * The markers `FileCheckpoints.workdirForPath` treats as a project root. Kept
 * in sync with packages/cli-backend/src/checkpoints.ts by
 * `scripts/preflight.test.ts`, which reads that file — a hardcoded copy that
 * drifts would make this check pass over the very directory it is guarding.
 */
export const PROJECT_MARKERS = [
  '.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Makefile', '.hg',
] as const;

/* Scratch prefixes come from `@kinu.run/test-utils` (src/scratch.ts), which is
 * also what MINTS them — `judge` counts orphans and `reclaim` removes them from
 * that one list, so a prefix the harness knows and this file does not is
 * simultaneously uncollected and invisible. It was a hand-written copy here,
 * and it drifted exactly that way: measured 2026-08-17, 6,102 of 8,643 of our
 * own entries were counted, so every rising number quoted from this gate all
 * evening was a FLOOR and not a total. `kinu-scaffold-test-`,
 * `kinu-runtimes-`, `kinu-webhook-`, `kinu-vfs-`, `kinu-gepa-`,
 * `kinu-codex-auth-`, `kinu-shared-`, `kinu-mcp-test-` and every
 * `agent-core-*` were the invisible part. */

/* There is deliberately no threshold on the orphan COUNT. It was one, at 600,
 * and it was wrong in the way that gets gates weakened: on a box running many
 * agents concurrently it read 10,291 while the filesystem was perfectly
 * healthy, so the very first thing anyone would have done is raise the number,
 * and the second time they would have deleted the check. The count is not the
 * invariant. Free inodes are — the count only explains WHY they are low, so it
 * is reported inside that finding and on the success line, and it is never a
 * verdict of its own. */

/** The engine whose walk this check is about. Read rather than imported: the
 *  question is what the SHIPPED source does, and a gate that imports the
 *  function it is judging cannot tell a present bound from a removed one. */
const ENGINE = 'packages/cli-backend/src/checkpoints.ts';

/**
 * Whether `workdirForPath` stops its ancestor walk at the temp directory.
 *
 * With the bound, a marker at or above the temp directory claims nothing: the
 * walk breaks before it probes there, so a stray `pyproject.toml` in a shared
 * `/tmp` is harmless and refusing a push for it is a false blocker. Without
 * the bound, that marker owns every host write beneath it — measured at
 * 24,483 ms for one `laptop.writeFile`, which surfaces as a 5,000 ms timeout
 * in whichever suite wrote first. So the marker is a FINDING only while the
 * bound is missing, and this is the half that decides which.
 */
export function engineBoundsTempWalk(source: string): boolean {
  const walk = source.slice(source.indexOf('workdirForPath(path: string): string {'));
  const body = walk.slice(0, walk.indexOf('\n    },'));
  return body.includes('resolve(tmpdir())')
    && /if \(probe === temp \|\| real === realTemp\) break;/u.test(body);
}

export interface Environment {
  readonly temp: string;
  readonly freeInodes: number;
  readonly freeBytes: number;
  /** Directories between the temp dir and `/` that carry a project marker.
   *  Nearest first. Harmless while the engine bounds its walk; each one owns
   *  every host write beneath it once that bound is gone. */
  readonly markedAncestors: readonly string[];
  /** Whether the shipped engine still stops its walk at the temp directory. */
  readonly workdirWalkBounded: boolean;
  readonly scratchOrphans: number;
  readonly tempEntries: number;
  /** The commit being merged in, when a merge is half-resolved. A tree in that
   *  state holds BOTH versions of every conflicted file, so nothing downstream
   *  is measuring either one. */
  readonly mergeInProgress: string | null;
  readonly conflictedPaths: number;
}

/** Ancestors of `from` up to but excluding `/`, nearest first, that a
 *  `workdirForPath` walk would accept as a project root. `$HOME` terminates the
 *  walk in the engine, so it terminates here. */
export function unboundedWorkdirsAbove(from: string, home: string): string[] {
  const hits: string[] = [];
  let probe = resolve(from);
  const stop = resolve(home);
  while (probe !== dirname(probe) && probe !== stop) {
    if (PROJECT_MARKERS.some((marker) => existsSync(join(probe, marker)))) hits.push(probe);
    probe = dirname(probe);
  }
  return hits;
}

export function observe(): Environment {
  const temp = resolve(tmpdir());
  const fs = statfsSync(temp);
  const entries = readdirSync(temp);
  let orphans = 0;
  for (const name of entries) {
    if (SCRATCH_PREFIXES.some((prefix) => name.startsWith(prefix))) orphans += 1;
  }
  return {
    temp,
    freeInodes: fs.ffree,
    freeBytes: fs.bavail * fs.bsize,
    markedAncestors: unboundedWorkdirsAbove(temp, process.env.HOME ?? '/root'),
    workdirWalkBounded: engineBoundsTempWalk(readFileSync(join(repo, ENGINE), 'utf8')),
    scratchOrphans: orphans,
    tempEntries: entries.length,
    mergeInProgress: existsSync(join(repo, '.git/MERGE_HEAD'))
      ? readFileSync(join(repo, '.git/MERGE_HEAD'), 'utf8').trim().slice(0, 12)
      : null,
    conflictedPaths: Bun.spawnSync(
      ['git', 'diff', '--name-only', '--diff-filter=U'],
      { cwd: repo, stdout: 'pipe' },
    ).stdout.toString().split('\n').filter((path) => path.length > 0).length,
  };
}

export function judge(env: Environment): string[] {
  const problems: string[] = [];

  if (env.freeInodes < MIN_FREE_INODES) {
    problems.push(finding({
      at: env.temp,
      invariant: `the temp filesystem keeps at least ${String(MIN_FREE_INODES)} free inodes `
        + `— two full suite runs at ${String(INODES_PER_FULL_RUN)} each`,
      found: `${String(env.freeInodes)} free inodes, ${String(env.scratchOrphans)} of `
        + `${String(env.tempEntries)} entries are our own test scratch`,
      silently: 'git and every mkdtemp in the suite start failing or crawling, and it '
        + 'surfaces as "this test timed out after 5000ms" in whichever test happens to '
        + 'write first — never in the one that leaked',
      fix: 'bun scripts/preflight.ts --reclaim   # removes kinu-{test-home,home,mount}-* '
        + 'older than 2h, then re-run',
    }));
  }

  if (env.freeBytes < MIN_FREE_BYTES) {
    problems.push(finding({
      at: env.temp,
      invariant: `the temp filesystem keeps at least ${String(MIN_FREE_BYTES >> 30)} GiB free`,
      found: `${String(env.freeBytes >> 20)} MiB free`,
      silently: 'a suite that writes a database or a checkpoint store gets ENOSPC and '
        + 'reports it as whatever assertion happened to be next',
      fix: 'bun scripts/preflight.ts --reclaim',
    }));
  }

  if (!env.workdirWalkBounded) {
    for (const dir of env.markedAncestors) {
      problems.push(finding({
        at: `${dir} (marker for a checkpoint working directory)`,
        invariant: `${ENGINE} workdirForPath stops its walk at the temp directory`,
        found: `the walk carries no temp bound, and ${dir} carries `
          + `${PROJECT_MARKERS.filter((m) => existsSync(join(dir, m))).join(', ')}`,
        silently: `every host write under ${env.temp} resolves its checkpoint working `
          + `directory to ${dir} and shadow-git-adds the whole of it — measured at 24,483 ms `
          + 'for one laptop.writeFile, which lands as a 5,000 ms test timeout elsewhere',
        fix: `restore the temp bound in ${ENGINE} workdirForPath (a scratch directory is `
          + 'never a project root), which packages/cli-backend/tests/'
          + 'checkpoint-workdir-bound.test.ts proves in both directions',
      }));
    }
  }

  // Repo-scale version of the same fault the checkpoint-workdir check catches:
  // the thing the gates are about to measure is not in a state anyone should
  // draw a conclusion from. A half-resolved merge had to be broadcast to every
  // agent by hand today, twice, because typecheck/lint/suites all went red and
  // each red read as somebody's change.
  // Gate on UNRESOLVED paths, not on the merge existing. A fully resolved merge
  // whose only remaining step is the commit is a tree every gate can measure
  // honestly — and gating on `MERGE_HEAD` alone made this check unsatisfiable
  // from a pre-commit hook: the hook refused the very commit that concludes the
  // merge, so the merge could never be finished without `--no-verify`, which is
  // banned. The hazard is a file holding both versions, and that is exactly
  // `conflictedPaths > 0`.
  if (env.mergeInProgress !== null && env.conflictedPaths > 0) {
    problems.push(finding({
      at: `${repo} (merging ${env.mergeInProgress})`,
      invariant: 'the tree is not half-way through a merge when a gate measures it',
      found: `.git/MERGE_HEAD is present with ${String(env.conflictedPaths)} unresolved path(s)`,
      silently: 'a conflicted file holds BOTH versions, so typecheck, lint and every suite '
        + 'report on a tree that is neither one. A grep matches text from a branch that has '
        + 'not landed, and a line number points at neither version — two streams nearly '
        + 'published citations from marker-displaced offsets in the same ten minutes. Every '
        + 'red below this line would be attributed to whatever change was under review.',
      fix: 'resolve the merge first (git status, git diff --diff-filter=U), then re-run. Do '
        + 'not report the gates below as red and do not revert anything — this is not about '
        + 'your change.',
    }));
  }

  // (no orphan-count verdict — see the note above SCRATCH_PREFIXES' threshold)

  return problems;
}

/** What `reclaim` reclaimed. Named because the anti-slop contract rejects an
 *  anonymous return shape: the caller reads both fields and prints them. */
export interface ReclaimResult {
  readonly removed: number;
  readonly kept: number;
}

/** Removes scratch our own harness minted and abandoned. Only entries older
 *  than the cutoff, because a sibling suite may be mid-run in one of them. */
export function reclaim(temp: string, olderThanMs: number): ReclaimResult {
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  let kept = 0;
  for (const name of readdirSync(temp)) {
    if (!SCRATCH_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const path = join(temp, name);
    try {
      if (statSync(path).mtimeMs >= cutoff) { kept += 1; continue; }
      Bun.spawnSync(['rm', '-rf', path]);
      removed += 1;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      kept += 1;
    }
  }
  return { removed, kept };
}

if (import.meta.main) {
  const env = observe();

  if (process.argv.includes('--reclaim')) {
    const { removed, kept } = reclaim(env.temp, 2 * 60 * 60 * 1000);
    const after = observe();
    console.log(
      `preflight: reclaimed ${String(removed)} scratch entries (kept ${String(kept)} younger `
      + `than 2h); free inodes ${String(env.freeInodes)} → ${String(after.freeInodes)}`,
    );
    process.exit(0);
  }

  // Zero leaked scratch is the HEALTHY reading — a clean boot or a fresh
  // reclaim both produce it — so it is stated as text, not fed to
  // assertMeasured: a count that is legitimately zero would make the throw
  // fire on a clean machine. The scan itself is still proven: tempEntries
  // and free inodes stay in the must-be-measured set, so a broken path or
  // glob cannot read as an empty temp directory.
  const measured = assertMeasured('preflight', [
    ['free inodes', env.freeInodes],
    ['entries in the temp directory', env.tempEntries],
    ['project markers probed per ancestor', PROJECT_MARKERS.length],
  ]);
  // On the SUCCESS path, because a limitation visible only in red output is
  // invisible exactly when the tree is green: markers above a shared temp
  // directory are tolerated solely because the engine bounds its own walk.
  // Deliberately NOT one of the counts above: zero marked ancestors is a clean
  // machine, and `assertMeasured` rightly refuses a zero it would read as a
  // gate that scanned nothing. The probe's own denominator is the marker count.
  if (env.markedAncestors.length > 0 && env.workdirWalkBounded) {
    process.stdout.write(
      `preflight: tolerated — ${env.markedAncestors.join(', ')} `
      + `${env.markedAncestors.length === 1 ? 'carries' : 'carry'} a project marker, `
      + `harmless while ${ENGINE} bounds its walk at the temp directory\n`,
    );
  }
  const problems = judge(env);
  if (problems.length === 0) {
    console.log(`preflight: ok — ${measured}, `
      + `${String(env.scratchOrphans)} of them our own leaked test scratch, no merge in progress`);
    process.exit(0);
  }
  console.error(`preflight: ${String(problems.length)} environment fault(s)\n`);
  for (const problem of problems) console.error(problem);
  console.error(
    '\nThese are not defects in the change under test. Every gate after this one would '
    + '\nhave reported on an environment nobody looked at.',
  );
  process.exit(1);
}
