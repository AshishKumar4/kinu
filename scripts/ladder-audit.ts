/**
 * The closure audit: what a gate REALLY opens, against what its closure says.
 *
 * A `reads` declaration on a ladder row is a claim. This runs the gate under
 * `strace -f -e trace=openat,execve` and reports every file under the tree
 * the gate opened that its derived closure does not hold. A finding is a
 * hole in the cache key, never a warning: the fix is a `reads` entry on the
 * row (an input added to the closure), and this is how that entry is
 * written. Files outside the tree and under `node_modules` are not findings;
 * the lock and the patches stand for the second, and the first is the
 * cache's stated blind spot.
 *
 * Reads only. A gate that WRITES into the tree is a scheduler question (see
 * a row's `phase`), not a closure one, and `--audit-closure` does not judge it.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { BUILT_OUTPUTS, type Derived } from './ladder-closure';

export interface Audit {
  /** Repo-relative files the gate opened that the closure does not hold. */
  readonly undeclared: readonly string[];
  /** Files opened that the closure holds, for the record. */
  readonly covered: number;
  /** Absolute paths outside the tree, counted and not judged. */
  readonly outside: number;
  /** The traced gate's exit status: a trace of a run that failed is a partial run's opens. */
  readonly exitCode: number | null;
}

/** Parse strace's `-y`-less openat lines: `openat(AT_FDCWD, "path", flags)`. */
function openedPaths(trace: string, cwd: string): string[] {
  const out: string[] = [];

  for (const line of trace.split('\n')) {
    const match = /openat\((?:AT_FDCWD|\d+), "([^"]+)"/.exec(line) ?? /execve\("([^"]+)"/.exec(line);
    const path = match?.[1];

    if (path === undefined) continue;
    out.push(path.startsWith('/') ? path : join(cwd, path));
  }

  return out;
}

/** Run `argv` under strace in `root`, with the environment the ladder gives
 *  the gate, and compare what it opened with `closure`. */
/** Whether the closure holds `input`, a tracked file or a directory with a trailing slash. */
function heldInput(held: ReadonlySet<string>, input: string): boolean {
  return input.endsWith('/') ? [...held].some((file) => file.startsWith(input)) : held.has(input);
}

export function auditClosure(argv: readonly string[], root: string, closure: Derived, env: Record<string, string>): Audit {
  const scratch = mkdtempSync(join(tmpdir(), 'kinu-ladder-audit-'));
  const trace = join(scratch, 'trace');

  try {
    const proc = Bun.spawnSync(
      ['strace', '-f', '-qq', '-e', 'trace=openat,execve', '-o', trace, ...argv],
      { cwd: root, env, stdout: 'ignore', stderr: 'ignore' },
    );

    if (!existsSync(trace)) throw new Error(`strace wrote no trace for ${argv.join(' ')} (exit ${String(proc.exitCode)})`);
    const held = new Set(closure.files);
    const undeclared = new Set<string>();
    let covered = 0;
    let outside = 0;
    const prefix = root.endsWith('/') ? root : `${root}/`;

    for (const opened of openedPaths(readFileSync(trace, 'utf8'), root)) {
      if (!opened.startsWith(prefix)) {
        outside += 1;
        continue;
      }

      const file = relative(root, opened);

      // Not findings: `node_modules` (the lock and the patches stand for it),
      // the repository itself (`.git` is a FILE in a worktree — the gitdir
      // pointer — and a directory in the primary; the enumeration opens it
      // to ask git, and git's answer is the corpus already in the closure),
      // and CPython bytecode caches, which are gitignored derivatives of the
      // `.py` sources the closure holds and which CPython invalidates against
      // the source's own size and mtime.
      if (file === '.git' || file.startsWith('.git/') || file.startsWith('node_modules/') || file.includes('/node_modules/')) continue;

      if (file.includes('/__pycache__/') && file.endsWith('.pyc')) continue;

      // A build output the closure holds every input of is held (`BUILT_OUTPUTS`).
      if (BUILT_OUTPUTS.some((built) => file.startsWith(built.output) && built.inputs.every((input) => heldInput(held, input)))) {
        covered += 1;
        continue;
      }

      if (held.has(file)) {
        covered += 1;
        continue;
      }

      // A directory opened for listing is not a file read; a path that no
      // longer exists (a scratch file the gate wrote and removed) is not one
      // either. Only a regular file the tree holds is a hole.
      if (existsSync(opened) && statSync(opened).isFile()) undeclared.add(file);
    }

    return { undeclared: [...undeclared].sort(), covered, outside, exitCode: proc.exitCode };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
