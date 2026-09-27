import { scratchDir } from '../src/scratch';
import { describe, expect, test } from 'bun:test';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';

import { git, gitEnv, initRepo } from '../src/git';
import { childEnv } from '../src/ambient-env';

const repo = (): string => {
  const directory = scratchDir('git-fixture');
  initRepo(directory);

  return directory;
};

const root = join(import.meta.dir, '..', '..', '..');

describe('git spawned by a test under a committing hook', () => {
  test.each(['preload', 'repeat', 'sweep'] as const)('%s leaves the hook repository and its index untouched', async (runner) => {
    const donor = repo();
    const target = repo();
    const directory = scratchDir('hook-git');
    const file = join(directory, 'probe.test.ts');
    writeFileSync(join(donor, 'seed.txt'), 'kept in the hook repository\n');
    git(donor, 'add', 'seed.txt');
    git(donor, 'commit', '-qm', 'seed');
    git(donor, 'config', 'core.hooksPath', 'protected-hooks');
    const hookIndex = join(directory, 'hook-index');
    copyFileSync(join(donor, '.git', 'index'), hookIndex);
    const hookEnv = childEnv({ GIT_DIR: join(donor, '.git'), GIT_WORK_TREE: donor, GIT_INDEX_FILE: hookIndex });
    writeFileSync(join(donor, 'queued.test.ts'), '// staged only in the committing hook\n');
    const staged = Bun.spawnSync(['git', 'add', 'queued.test.ts'], { cwd: donor, env: hookEnv, stderr: 'pipe' });

    if (staged.exitCode !== 0) throw new Error(staged.stderr.toString());
    writeFileSync(join(donor, 'probe.txt'), 'from the hook repository\n');
    writeFileSync(join(target, 'probe.txt'), 'from the scratch repository\n');
    const config = readFileSync(join(donor, '.git', 'config'), 'utf8');
    const index = readFileSync(hookIndex);

    // Bun's omitted env inherits its startup snapshot, not later process.env deletions (ADR L10).
    writeFileSync(file, `import { expect, test } from 'bun:test';
test('git writes only in this scratch repository', () => {
  const commands = [['add', 'probe.txt'], ['config', 'core.bare', 'true'], ['config', 'core.hooksPath', 'frontend/.husky']];
  const codes = commands.map(args => Bun.spawnSync(['git', ...args], {
    cwd: ${JSON.stringify(target)}, ${runner === 'preload' ? 'env: process.env,' : ''}
    stdout: 'pipe', stderr: 'inherit',
  }).exitCode);
  expect(codes).toEqual([0, 0, 0]);
});
`);

    const argv = ['bun', 'test', '--timeout=0', file];
    const module = join(root, 'scripts', 'flake-gate.ts');
    const row = { label: 'git hook isolation' };

    const script = runner === 'repeat'
      ? `import { repeatAll, stagedTestFiles, verdictOf } from ${JSON.stringify(module)};
const result = await repeatAll([${JSON.stringify({ kind: 'repeat', file: 'probe.test.ts', argv, runs: 1, lane: 'plain', row })}], ${JSON.stringify(directory)});
const outcomes = result.get('probe.test.ts') ?? [];
if (verdictOf(outcomes).kind !== 'green') throw new Error(JSON.stringify(outcomes));
if (JSON.stringify(stagedTestFiles()) !== '["queued.test.ts"]') throw new Error('the parent lost the committing index');`
      : `import { stagedTestFiles, sweepRun } from ${JSON.stringify(module)};
const result = await sweepRun(${JSON.stringify({ row, lane: 'plain', argv })}, 17, ${JSON.stringify(directory)}, 0);
if (result.exitCode !== 0) throw new Error(JSON.stringify(result));
if (JSON.stringify(stagedTestFiles()) !== '["queued.test.ts"]') throw new Error('the parent lost the committing index');`;

    const run = Bun.spawn(runner === 'preload' ? argv : [process.execPath, '-e', script], {
      cwd: root,
      env: hookEnv,
      stdout: 'ignore', stderr: 'pipe',
    });

    const [exitCode, stderr] = await Promise.all([run.exited, new Response(run.stderr).text()]);

    expect({ exitCode, stderr: exitCode === 0 ? '' : stderr }).toEqual({ exitCode: 0, stderr: '' });
    expect(readFileSync(join(donor, '.git', 'config'), 'utf8')).toBe(config);
    expect(readFileSync(hookIndex)).toEqual(index);
    expect(git(target, 'show', ':probe.txt')).toBe('from the scratch repository\n');
    expect(git(target, 'config', 'core.bare').trim()).toBe('true');
    expect(git(target, 'config', 'core.hooksPath').trim()).toBe('frontend/.husky');
  });
});

describe('the git test fixture', () => {
  /* A git hook exports GIT_DIR, which git obeys over `cwd`; these tests run with it set. */
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
