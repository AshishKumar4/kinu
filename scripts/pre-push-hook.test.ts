/**
 * The push tier proves the checked-out tree, so the pre-push hook must refuse a push
 * whose commit is not that tree. On 2026-09-30 a push of integration from the primary
 * checkout ran the tier on main and refused a green commit; a push from a dirty tree
 * proves files the commit does not carry, untracked ones included (scripts/sources.ts
 * reads untracked, non-ignored files into every gate's corpus).
 *
 * The real hook runs in a scratch repository whose `scripts/ladder.ts` is a stand-in that
 * prints one line and succeeds, so a push the guards admit must exit 0 having run it.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
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

function runHook(repo: string, pushed: string) {
  const result = spawnSync('bash', [join(repo, '.githooks', 'pre-push'), 'origin', 'git@example.invalid:r.git'], {
    cwd: repo, env: gitEnv(), input: `refs/heads/b ${pushed} refs/heads/b ${ZERO}\n`, encoding: 'utf8',
  });

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('the pre-push hook proves only the commit it pushes', () => {
  test('a push of a commit other than the checked-out one is refused, naming both', () => {
    const { repo, head, parent } = repoWithTwoCommits();
    const { status, stderr } = runHook(repo, parent);

    expect(status).toBe(1);
    expect(stderr).toContain(`this push sends ${parent}, but the push tier proves the checked-out ${head}`);
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
