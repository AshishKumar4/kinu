/**
 * The pre-commit hook lints what a commit wrote. On a merge that is what its resolution wrote: the files whose staged
 * content differs from every parent. Each other file is a parent's byte for byte, already linted where it was written.
 * On 2026-10-15 a clean merge of the integration tip staged about 250 files, and oxlint over all of them went past
 * local-check.sh's 4 GB scope, so no merge of the tip could commit through it.
 *
 * The real hook runs in a scratch repository whose `oxlint` is a stand-in that logs the files it was handed.
 */

import { describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git, gitEnv, initRepo, runToExit, scratchDir } from '@kinu.run/test-utils';

const HOOK = resolve(import.meta.dir, '..', '.githooks', 'pre-commit');

async function repoWithHook() {
  const repo = scratchDir('pre-commit');

  await initRepo(repo);
  mkdirSync(join(repo, '.githooks'));
  copyFileSync(HOOK, join(repo, '.githooks', 'pre-commit'));
  mkdirSync(join(repo, 'scripts'));
  copyFileSync(resolve(import.meta.dir, 'repo-runtime.sh'), join(repo, 'scripts', 'repo-runtime.sh'));
  mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
  symlinkSync(process.execPath, join(repo, 'node_modules', '.bin', 'bun'));
  const oxlint = join(repo, 'node_modules', '.bin', 'oxlint');
  writeFileSync(oxlint, '#!/usr/bin/env bash\nfor file in "$@"; do case "$file" in --*) ;; *) printf \'%s\\n\' "$file" >> node_modules/linted;; esac; done\n');
  chmodSync(oxlint, 0o755);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'shared.ts'), 'export const shared = 0;\n');
  writeFileSync(join(repo, 'kept.ts'), 'export const kept = 0;\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', 'base');

  return repo;
}

/** The hook as git runs it, and the files its oxlint was handed; null when it never ran oxlint. */
async function runHook(repo: string) {
  const result = await runToExit(['bash', join(repo, '.githooks', 'pre-commit')], { cwd: repo, env: gitEnv() });
  const log = join(repo, 'node_modules', 'linted');

  return { status: result.exitCode, linted: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').toSorted() : null };
}

/** `count` new files on a branch `side`, and `edits` on the checked-out branch, so the merge is a real one. */
async function sideWith(repo: string, count: number, edits: Readonly<Record<string, string>>) {
  await git(repo, 'checkout', '-q', '-b', 'side');

  for (let index = 0; index < count; index += 1) writeFileSync(join(repo, `side-${String(index)}.ts`), `export const n = ${String(index)};\n`);
  writeFileSync(join(repo, 'shared.ts'), 'export const shared = 1;\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', 'side');
  await git(repo, 'checkout', '-q', '-');

  for (const [file, text] of Object.entries(edits)) writeFileSync(join(repo, file), text);
  await git(repo, 'commit', '-q', '-am', 'main');
}

describe('a merge lints what its resolution wrote', () => {
  test('a clean merge of 250 files hands oxlint none of them', async () => {
    const repo = await repoWithHook();
    await sideWith(repo, 250, { 'kept.ts': 'export const kept = 1;\n' });

    await git(repo, 'merge', '--no-commit', '--no-ff', '-q', 'side');

    expect(await runHook(repo)).toEqual({ status: 0, linted: null });
  });

  test('a conflict resolved by hand is linted, and every file a parent wrote is not', async () => {
    const repo = await repoWithHook();
    await sideWith(repo, 3, { 'shared.ts': 'export const shared = 2;\n', 'kept.ts': 'export const kept = 1;\n' });

    const merged = await runToExit(['git', 'merge', '--no-commit', '-q', 'side'], { cwd: repo, env: gitEnv() });
    expect(merged.exitCode).not.toBe(0);
    writeFileSync(join(repo, 'shared.ts'), 'export const shared = 3;\n');
    // A resolution may also write a file neither parent has.
    writeFileSync(join(repo, 'bridge.ts'), 'export const bridge = 0;\n');
    await git(repo, 'add', 'shared.ts', 'bridge.ts');

    expect(await runHook(repo)).toEqual({ status: 0, linted: ['bridge.ts', 'shared.ts'] });
  });

  test('a file one side wrote, edited again in the resolution, is linted', async () => {
    const repo = await repoWithHook();
    await sideWith(repo, 2, { 'kept.ts': 'export const kept = 1;\n' });

    await git(repo, 'merge', '--no-commit', '--no-ff', '-q', 'side');
    writeFileSync(join(repo, 'side-1.ts'), 'export const n = 11;\n');
    await git(repo, 'add', 'side-1.ts');

    expect(await runHook(repo)).toEqual({ status: 0, linted: ['side-1.ts'] });
  });
});

test('an ordinary commit lints every file it stages', async () => {
  const repo = await repoWithHook();
  writeFileSync(join(repo, 'kept.ts'), 'export const kept = 1;\n');
  writeFileSync(join(repo, 'fresh.ts'), 'export const fresh = 0;\n');
  writeFileSync(join(repo, 'notes.md'), 'not linted\n');
  await git(repo, 'add', '.');

  expect(await runHook(repo)).toEqual({ status: 0, linted: ['fresh.ts', 'kept.ts'] });
});
