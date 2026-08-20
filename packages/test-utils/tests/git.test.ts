import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git, gitEnv, initRepo } from '../src/git';

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const repo = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'kinu-git-fixture-'));
  scratch.push(directory);
  initRepo(directory);
  return directory;
};

describe('the git test fixture', () => {
  /* The defect this exists for, exactly: a git hook exports GIT_DIR, git obeys
     it over `cwd`, and a fixture that spelled its target as `cwd` committed into
     the developer's checkout instead — four failed pushes, four junk commits.
     These tests run WITH that environment set, because a fixture proven only in
     a clean shell proves nothing about the case that broke. */
  const underHook = <T>(elsewhere: string, run: () => T): T => {
    const saved = { dir: process.env.GIT_DIR, work: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = join(elsewhere, '.git');
    process.env.GIT_WORK_TREE = elsewhere;
    try { return run(); } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved.dir;
      if (saved.work === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = saved.work;
    }
  };

  test('a commit lands in the named repository, not the ambient one', () => {
    const bystander = repo();
    const target = repo();
    writeFileSync(join(bystander, 'seed.txt'), 'x\n');
    git(bystander, 'add', '-A');
    git(bystander, 'commit', '-qm', 'bystander');
    const before = git(bystander, 'rev-parse', 'HEAD').trim();

    underHook(bystander, () => {
      writeFileSync(join(target, 'file.txt'), 'y\n');
      git(target, 'add', '-A');
      git(target, 'commit', '-qm', 'target');
    });

    expect(git(bystander, 'rev-parse', 'HEAD').trim()).toBe(before);
    expect(git(bystander, 'log', '--oneline').trim()).not.toContain('target');
    expect(git(target, 'log', '--oneline').trim()).toContain('target');
  });

  test('gitEnv drops every GIT_ variable, not a list of known ones', () => {
    process.env.GIT_INDEX_FILE = '/tmp/nope';
    process.env.GIT_OBJECT_DIRECTORY = '/tmp/nope';
    try {
      const env = gitEnv();
      expect(Object.keys(env).filter((key) => key.startsWith('GIT_')))
        .toEqual(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']);
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env.GIT_INDEX_FILE;
      delete process.env.GIT_OBJECT_DIRECTORY;
    }
  });

  test('the fixture repo carries its own identity, not the developer\'s', () => {
    const target = repo();
    expect(git(target, 'config', 'user.email').trim()).toBe('kinu@example.invalid');
  });
});
