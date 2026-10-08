/**
 * The local tier proves the checked-out tree, so the pre-push hook must refuse a push
 * whose commit is not that tree. On 2026-09-30 a push of integration from the primary
 * checkout ran the tier on main and refused a green commit; a push from a dirty tree
 * proves files the commit does not carry, untracked ones included (scripts/sources.ts
 * reads untracked, non-ignored files into every gate's corpus).
 *
 * A push to main or integration/** is CI's instead (L25): armada proves the pushed commit
 * itself, so neither guard holds it, and every row of armada's verdict must be green.
 *
 * The real hook runs in a scratch repository whose `scripts/ladder.ts` is a stand-in that
 * prints one line and succeeds, so a push the guards admit must exit 0 having run it, and
 * whose pinned `armada` is a stand-in that answers as the test says and logs what it was asked.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git, gitEnv, initRepo, scratchDir } from '@kinu.run/test-utils';

const HOOK = resolve(import.meta.dir, '..', '.githooks', 'pre-push');

const ZERO = '0000000000000000000000000000000000000000';

const TIER_RAN = 'stand-in push tier ran';

function repoWithTwoCommits() {
  const repo = scratchDir('pre-push');

  initRepo(repo);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'one');
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  git(repo, 'commit', '-q', '-am', 'two');
  mkdirSync(join(repo, '.githooks'));
  copyFileSync(HOOK, join(repo, '.githooks', 'pre-push'));
  mkdirSync(join(repo, 'scripts'));
  copyFileSync(resolve(import.meta.dir, 'repo-runtime.sh'), join(repo, 'scripts', 'repo-runtime.sh'));
  mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
  symlinkSync(process.execPath, join(repo, 'node_modules', '.bin', 'bun'));
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'scripts', 'ladder.ts'), `console.log(${JSON.stringify(TIER_RAN)});\n`);
  git(repo, 'add', '.githooks', '.gitignore', 'scripts');
  git(repo, 'commit', '-q', '-m', 'hook');

  return { repo, head: git(repo, 'rev-parse', 'HEAD').trim(), parent: git(repo, 'rev-parse', 'HEAD~1').trim() };
}

function runHook(repo: string, pushed: string, ref = 'refs/heads/b', armada: Record<string, string> = {}) {
  const result = spawnSync('bash', [join(repo, '.githooks', 'pre-push'), 'origin', 'git@example.invalid:r.git'], {
    cwd: repo, env: { ...gitEnv(), ...armada }, input: `refs/heads/b ${pushed} ${ref} ${ZERO}\n`, encoding: 'utf8',
  });

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A stand-in for Kinu's pinned armada: `verdict --json` prints STORED and exits VERDICT_EXIT, `verdict` says the
 *  verdict, `run` exits RUN_EXIT; each call is logged to ARMADA_LOG. */
function withArmada(repo: string): string {
  const log = join(repo, 'armada.log');

  writeFileSync(join(repo, 'node_modules', '.bin', 'armada'), `#!/bin/sh
echo "$*" >> "$ARMADA_LOG"
case "$1 $3" in
  "verdict --json") printf '%s\\n' "$STORED"; exit "$VERDICT_EXIT" ;;
  verdict*) echo "FAIL: 89 of 90 rows green"; exit "$VERDICT_EXIT" ;;
  run*) echo "PASS: 90 of 90 rows green"; exit "$RUN_EXIT" ;;
esac
`, { mode: 0o755 });

  return log;
}

describe('the pre-push hook proves only the commit it pushes', () => {
  test('a push of a commit other than the checked-out one is refused, naming both', () => {
    const { repo, head, parent } = repoWithTwoCommits();
    const { status, stderr } = runHook(repo, parent);

    expect(status).toBe(1);
    expect(stderr).toContain(parent);
    expect(stderr).toContain(head);
  });

  test('a push of the checked-out commit from a clean tree runs the tier and passes', () => {
    const { repo, head } = repoWithTwoCommits();
    const { status, stdout } = runHook(repo, head);

    expect(status).toBe(0);
    expect(stdout).toContain(TIER_RAN);
  });

  test('a branch deletion is not a pushed commit', () => {
    const { repo } = repoWithTwoCommits();
    const { status, stdout } = runHook(repo, ZERO);

    expect(status).toBe(0);
    expect(stdout).toContain(TIER_RAN);
  });

  test.each([
    ['a modified tracked file', 'a.txt', 'three\n'],
    ['an untracked file, which the gates read', 'new.ts', 'export const x = 1;\n'],
  ])('%s is refused', (_, path, text) => {
    const { repo, head } = repoWithTwoCommits();

    writeFileSync(join(repo, path), text);

    const { status, stderr } = runHook(repo, head);

    expect(status).toBe(1);
    expect(stderr).toContain('uncommitted or untracked changes');
  });
});

describe('a push to main or integration/** is proved on armada', () => {
  const answering = (log: string, stored: string, verdictExit: number, runExit = 0) => ({ ARMADA_LOG: log, STORED: stored, VERDICT_EXIT: String(verdictExit), RUN_EXIT: String(runExit) });

  test('a commit armada stored green goes through without a run, and the local tier is not run for it', () => {
    const { repo, head } = repoWithTwoCommits();
    const log = withArmada(repo);
    const { status, stdout } = runHook(repo, head, 'refs/heads/integration/0965', answering(log, '{"rows": []}', 0));

    expect({ status, proved: stdout.includes(`armada already proved ${head} green`), tier: stdout.includes(TIER_RAN), asked: readFileSync(log, 'utf8') })
      .toEqual({ status: 0, proved: true, tier: false, asked: `verdict ${head} --json\n` });
  });

  test('a commit armada stored red is refused and not run again', () => {
    const { repo, head } = repoWithTwoCommits();
    const log = withArmada(repo);
    const { status, stderr } = runHook(repo, head, 'refs/heads/main', answering(log, '{"rows": []}', 1));

    expect({ status, said: stderr.includes(`armada proved ${head} red`), asked: readFileSync(log, 'utf8').split('\n').filter(Boolean) })
      .toEqual({ status: 1, said: true, asked: [`verdict ${head} --json`, `verdict ${head}`] });
  });

  test.each([[0, 0], [1, 1], [2, 1]])('a commit with no verdict is run on armada, and a run that exits %i lets the push exit %i', (runExit, pushExit) => {
    const { repo, head } = repoWithTwoCommits();
    const log = withArmada(repo);
    const { status } = runHook(repo, head, 'refs/heads/integration/0965', answering(log, 'null', 2, runExit));

    expect({ status, asked: readFileSync(log, 'utf8').split('\n').filter(Boolean) }).toEqual({ status: pushExit, asked: [`verdict ${head} --json`, `run ${head}`] });
  });

  test('an armada that cannot say is a refusal, never a run', () => {
    const { repo, head } = repoWithTwoCommits();
    const log = withArmada(repo);
    const { status, stderr } = runHook(repo, head, 'refs/heads/main', answering(log, '', 2));

    expect({ status, said: stderr.includes(`armada could not say whether ${head} is proved`), ran: readFileSync(log, 'utf8').includes('run ') }).toEqual({ status: 1, said: true, ran: false });
  });

  // armada proves the commit it is given, not the working tree, so a push of another commit from a dirty one is fine.
  test('neither the checked-out commit nor a clean tree is required', () => {
    const { repo, parent } = repoWithTwoCommits();
    const log = withArmada(repo);

    writeFileSync(join(repo, 'new.ts'), 'export const x = 1;\n');

    expect(runHook(repo, parent, 'refs/heads/integration/0965', answering(log, '{"rows": []}', 0)).status).toBe(0);
  });
});
