/**
 * What `mutation-sweep.ts` and `mutation-pilot.ts` share: the refusals that keep a mutant out of a shared tree, the
 * pristine bytes of every mutated file (put back on an interrupt), the suite runner, and the cheap defender guess.
 * Each program keeps its own way of choosing and writing a mutant.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitIn } from '../packages/test-utils/src/git-env';
import { moduleSpecifiers, parse } from './syntax';
import { REPO_ROOT as root } from './repo-root';


/**
 * Refuse to run anywhere a concurrent reader could load a mutant.
 *
 * The main checkout is shared: other agents, other suites and the editor all read it.
 * A worktree is one branch's own tree, and `setup-worktree.sh` has already given it
 * its own workspace scope, so a mutation there is visible to this process only.
 */
export function requireOwnWorktree(): void {
  const tree = gitIn(root, 'rev-parse', '--show-toplevel');
  const main = dirname(gitIn(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'));

  if (tree === main) {
    throw new Error(
      `Refusing to mutate ${tree}: this is the main checkout, which every other agent, `
      + 'suite and editor reads. In-place mutation in a shared tree makes a test fail for '
      + 'a reason that is not in the code, and every concurrent suite overlapping the '
      + 'window reports a meaningless green or a misattributed red. Run this in a worktree:'
      + '\n  git worktree add ../Kinu-mutation -b test/my-mutation main'
      + '\n  cd ../Kinu-mutation && bash scripts/setup-worktree.sh',
    );
  }
}

/** Refuse when a target file already differs from HEAD. The run restores the exact pristine bytes it read, so a local
 *  edit would survive intact, but if this process is killed outright `git checkout --` is the recovery, and that
 *  recovery must not be able to destroy work. */
export function requireCleanTargets(files: readonly string[]): void {
  const dirty = gitIn(root, 'status', '--porcelain', '--', ...files);

  if (dirty !== '') {
    throw new Error(
      'Refusing to mutate: these targets have uncommitted changes, and the recovery from '
      + `an interrupted run is 'git checkout --', which would discard them.\n${dirty}`,
    );
  }
}

/** The pristine text of every file this process has mutated, so an interrupt can put them all back. */
const pristine = new Map<string, string>();

function restoreAll(): void {
  for (const [file, text] of pristine) writeFileSync(join(root, file), text);
  pristine.clear();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    restoreAll();
    process.exit(130);
  });
}

/** Write `mutated` over `file`, whose pristine text the caller read and checked as `source`. */
export function writeMutant(file: string, source: string, mutated: string): void {
  pristine.set(file, source);
  writeFileSync(join(root, file), mutated);
}

/** Put `file` back, and prove it went back; `id` names the mutant in the refusal. */
export function restoreMutant(file: string, id: string): void {
  const text = pristine.get(file);

  if (text === undefined) throw new Error(`${file} was never mutated`);
  const path = join(root, file);
  writeFileSync(path, text);
  pristine.delete(file);

  if (readFileSync(path, 'utf8') !== text) {
    throw new Error(
      `${file} did not restore to its pristine bytes after "${id}". Stopping so no later result is measured against `
      + `a mutant. Recover with: git -C ${root} checkout -- ${file}`,
    );
  }
}

export interface Run {
  readonly failed: boolean;
  readonly timedOut: boolean;
  /** The runtime died by a signal well inside its deadline twice running, so it says nothing about the mutant. */
  readonly crashed: boolean;
  readonly ms: number;
  readonly output: string;
}

/**
 * One `bun test` invocation, with a signal death told apart from a deadline.
 *
 * A SIGNAL IS NOT A CLOCK, and reading `exitCode === null` as "timed out" is the
 * mistake this function exists to not make. Measured 2026-08-19: the
 * `provider-options-override-wins` mutant reported TIMEOUT after 78 s against a 216 s
 * deadline, which is arithmetically impossible. The real cause was a Bun 1.3.14
 * segmentation fault in `packages/cli-backend`, and it did not reproduce on the next
 * run — an intermittent runtime crash wearing a clock's clothes. Both a deadline kill
 * and a crash leave `exitCode` null, so the elapsed time is what separates them, and a
 * crash is retried once because an intermittent fault is not a finding.
 */
export function runSuites(paths: readonly string[], deadlineMs: number | undefined): Run {
  const once = (): Run => {
    const started = Date.now();

    // `timeout: undefined` is how the baseline says it has no bound to derive one from:
    // it is the run that MEASURES the bound every later mutant is held to.
    const spawned = Bun.spawnSync({
      cmd: ['bun', 'test', '--timeout=0', ...paths],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, FORCE_COLOR: '0' },
      timeout: deadlineMs,
      killSignal: 'SIGKILL',
    });

    const ms = Date.now() - started;
    const bySignal = spawned.exitCode === null;
    const reachedDeadline = deadlineMs !== undefined && ms >= deadlineMs;

    return {
      failed: spawned.exitCode !== 0,
      timedOut: bySignal && reachedDeadline,
      crashed: bySignal && !reachedDeadline,
      ms,
      output: `${spawned.stdout.toString()}${spawned.stderr.toString()}`,
    };
  };

  const first = once();

  if (!first.crashed) return first;
  const again = once();

  return { ...again, ms: first.ms + again.ms };
}

/**
 * Suites that could plausibly see a mutant of `file`, cheaply: the ones importing it directly, and the ones naming
 * `symbol`. Only ever an optimisation: a mutant surviving this set is escalated to whole tiers, so an under-inclusive
 * answer costs time on a kill and can never invent a survivor.
 */
export function candidateDefenders(file: string, symbol: string | null, suites: ReadonlyMap<string, string>): readonly string[] {
  const target = join(root, file);
  const found: string[] = [];

  for (const [suite, text] of suites) {
    if (symbol !== null && text.includes(symbol)) {
      found.push(suite);
      continue;
    }

    const imports = moduleSpecifiers(parse(suite, text).root)
      .filter((specifier) => specifier.startsWith('.'))
      .map((specifier) => join(root, dirname(suite), specifier));

    if (imports.some((path) => target === path || target === `${path}.ts`)) found.push(suite);
  }

  return found;
}
