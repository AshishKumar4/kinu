/**
 * The closure audit: what a gate REALLY opens, against what its closure says.
 *
 * A `reads` declaration on a ladder row is a claim. This runs the gate under
 * `strace -f -y -e trace=openat,execve` and reports every file under the tree
 * the gate opened that its derived closure does not hold. A finding is a
 * hole in the cache key, never a warning: the fix is a `reads` entry on the
 * row (an input added to the closure), and this is how that entry is
 * written. Files outside the tree and under `node_modules` are not findings;
 * the lock and the patches stand for the second, and the first is the
 * cache's stated blind spot. Each open is judged where it really lives: a
 * workspace package reached through `node_modules` is the tracked tree.
 *
 * Reads only. A gate that WRITES into the tree is a scheduler question (see
 * a row's `phase`), not a closure one, and `--audit-closure` does not judge it.
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { Derived } from './ladder-closure';

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

/** The real path of every file a `strace -y` trace opened or executed. An
 *  openat names its directory with the path `-y` prints (`AT_FDCWD</cwd>`,
 *  `12</repo/packages/core>`): Bun opens a package's own package.json and
 *  tsconfig.json through a descriptor on the package, so a name joined onto the
 *  gate's cwd would judge the root's files in their place. Links are followed,
 *  so a tracked file opened as `node_modules/@kinu.run/core/package.json` is
 *  judged as the `packages/core/package.json` it is. */
function openedPaths(trace: string, cwd: string): string[] {
  const out: string[] = [];

  for (const line of trace.split('\n')) {
    const [, dir, name] = /openat\((?:AT_FDCWD|\d+)<([^>]*)>, "([^"]+)"/.exec(line) ?? [];
    const [, executed] = /execve\("([^"]+)"/.exec(line) ?? [];
    const opened = name === undefined ? executed : resolve(dir ?? cwd, name);

    if (opened === undefined) continue;
    const path = resolve(cwd, opened);

    out.push(existsSync(path) ? realpathSync(path) : path);
  }

  return out;
}

/** Run `argv` under strace in `root`, with the environment the ladder gives
 *  the gate, and compare what it opened with `closure`. */
export function auditClosure(argv: readonly string[], root: string, closure: Derived, env: Record<string, string>): Audit {
  const scratch = mkdtempSync(join(tmpdir(), 'kinu-ladder-audit-'));
  const trace = join(scratch, 'trace');

  try {
    const proc = Bun.spawnSync(
      // A call split across processes prints its arguments on the `<unfinished ...>` half, which is the half read.
      ['strace', '-f', '-y', '-qq', '-e', 'trace=openat,execve', '-o', trace, ...argv],
      { cwd: root, env, stdout: 'ignore', stderr: 'ignore' },
    );

    if (!existsSync(trace)) throw new Error(`strace wrote no trace for ${argv.join(' ')} (exit ${String(proc.exitCode)})`);
    const held = new Set(closure.files);
    const undeclared = new Set<string>();
    let covered = 0;
    let outside = 0;
    const real = realpathSync(root);
    const prefix = `${real}/`;

    for (const opened of openedPaths(readFileSync(trace, 'utf8'), root)) {
      if (!opened.startsWith(prefix)) {
        outside += 1;
        continue;
      }

      const file = relative(real, opened);

      // Not findings: what really lives in `node_modules` (the lock and the patches stand for it),
      // the repository itself (`.git` is a FILE in a worktree — the gitdir
      // pointer — and a directory in the primary; the enumeration opens it
      // to ask git, and git's answer is the corpus already in the closure),
      // and CPython bytecode caches, which are gitignored derivatives of the
      // `.py` sources the closure holds and which CPython invalidates against
      // the source's own size and mtime.
      if (file === '.git' || file.startsWith('.git/') || file.startsWith('node_modules/') || file.includes('/node_modules/')) continue;

      if (file.includes('/__pycache__/') && file.endsWith('.pyc')) continue;

      // A build output whose files the key hashes is held (`Derived.outputs`).
      if (closure.outputs.some((output) => file.startsWith(output))) {
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
