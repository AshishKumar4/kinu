/**
 * The input closure, proved red in every direction it claims over a throwaway
 * repository: a closure that errs narrow ships a stale green, so each rule that
 * makes a gate uncacheable is exercised as a refusal, and each rule that widens
 * a closure is exercised as a file that appears in it.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git, initRepo, scratchDir } from '@kinu.run/test-utils';
import { claims } from './ladder';
import { deriveClosure, repoAt } from './ladder-closure';
import type { Closure, Inputs, Repo } from './ladder-closure';

const DERIVED: Inputs = { kind: 'derived' };

const DECLARED: Inputs = { kind: 'derived', reads: [], env: [] };

/** A committed repository holding `files`, with a root manifest whose scripts
 *  are `scripts`. Every file is tracked, so the closure can name its bytes. */
function fixture(files: Record<string, string>, scripts: Record<string, string> = {}): Repo {
  const root = scratchDir('ladder-closure');
  initRepo(root);

  const all = {
    'package.json': JSON.stringify({ name: 'fixture', workspaces: ['packages/*'], scripts }),
    'bun.lock': '{}',
    'bunfig.toml': '[test]\npreload = ["./scripts/preload.ts"]\n',
    'scripts/preload.ts': 'export const preloaded = 1;',
    ...files,
  } satisfies Record<string, string>;

  for (const [file, text] of Object.entries(all)) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }

  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'fixture');

  return repoAt(root, (run, tracked) => claims(run, tracked));
}

function derived(closure: Closure): readonly string[] {
  if (closure.kind !== 'derived') throw new Error(`expected a derived closure, got ${closure.kind}: ${closure.why}`);

  return closure.files;
}

function refused(closure: Closure): string {
  if (closure.kind !== 'uncomputable') throw new Error(`expected a refusal, got ${closure.kind}`);

  return closure.why;
}

describe('ladder-closure — what a closure holds', () => {
  test('a bun test gate holds the suite, its graph, the preload, the configs on the path and the lock', () => {
    const repo = fixture({
      'packages/a/package.json': JSON.stringify({ name: '@f/a' }),
      'packages/a/tsconfig.json': '{}',
      'packages/a/src/lib.ts': "import { deep } from './deep';\nexport const lib = deep;",
      'packages/a/src/deep.ts': 'export const deep = 1;',
      'packages/a/src/unrelated.ts': 'export const unrelated = 1;',
      'packages/a/tests/lib.test.ts': "import { lib } from '../src/lib';\nexport const t = lib;",
    });

    const files = derived(deriveClosure('bun test packages/a/', DERIVED, repo));

    expect(files).toEqual([
      'bun.lock', 'bunfig.toml', 'package.json',
      'packages/a/package.json', 'packages/a/src/deep.ts', 'packages/a/src/lib.ts',
      'packages/a/tests/lib.test.ts', 'packages/a/tsconfig.json', 'scripts/preload.ts',
    ]);
    expect(files).not.toContain('packages/a/src/unrelated.ts');
  });

  test('type imports, re-exports, text imports and data assets are inputs too', () => {
    const repo = fixture({
      'scripts/g.ts': [
        "import type { T } from './types';",
        "export { again } from './again';",
        "import prompt from './prompt.md' with { type: 'text' };",
        "import data from './data.json';",
        'export const g = [prompt, data];',
      ].join('\n'),
      'scripts/types.ts': 'export type T = 1;',
      'scripts/again.ts': 'export const again = 1;',
      'scripts/prompt.md': 'hello',
      'scripts/data.json': '{}',
    });

    const files = derived(deriveClosure('bun scripts/g.ts', DERIVED, repo));
    expect(files).toContain('scripts/types.ts');
    expect(files).toContain('scripts/again.ts');
    expect(files).toContain('scripts/prompt.md');
    expect(files).toContain('scripts/data.json');
  });

  test('bun run over a file path runs that file', () => {
    const repo = fixture({ 'scripts/one.ts': 'export const one = 1;' });
    expect(derived(deriveClosure('bun run scripts/one.ts --matrix', DERIVED, repo))).toContain('scripts/one.ts');
  });

  test('a bun run gate resolves its script body and every && part', () => {
    const repo = fixture({
      'scripts/one.ts': 'export const one = 1;',
      'scripts/two.ts': 'export const two = 2;',
    }, { 'gate:both': 'bun scripts/one.ts && bun scripts/two.ts' });

    const files = derived(deriveClosure('bun run gate:both', DERIVED, repo));
    expect(files).toContain('scripts/one.ts');
    expect(files).toContain('scripts/two.ts');
    expect(files).toContain('package.json');
  });

  test('a graph that reaches the corpus module is the whole corpus, and a path read inside it needs no declaration', () => {
    const repo = fixture({
      'scripts/sources.ts': "import { readFileSync } from 'node:fs';\nexport const corpus = readFileSync('package.json');",
      'scripts/g.ts': "import { corpus } from './sources';\nexport const g = corpus;",
      'packages/x/far.ts': 'export const far = 1;',
      'docs/note.md': 'prose',
    });

    const closure = deriveClosure('bun scripts/g.ts', DERIVED, repo);
    expect(derived(closure)).toContain('packages/x/far.ts');
    expect(derived(closure)).toContain('docs/note.md');
    expect(closure.kind === 'derived' && closure.corpus).toBeTrue();
  });

  test('a row that declares corpus holds every tracked file, and its path reads need no list', () => {
    const repo = fixture({
      'scripts/g.ts': "import { readFileSync } from 'node:fs';\nexport const g = readFileSync('docs/note.md');",
      'docs/note.md': 'prose',
      'packages/x/far.ts': 'export const far = 1;',
    });

    const closure = deriveClosure('bun scripts/g.ts', { kind: 'derived', corpus: true }, repo);
    expect(derived(closure)).toContain('packages/x/far.ts');
    expect(derived(closure)).toContain('docs/note.md');
  });

  test('tsc and oxlint script parts read the whole corpus', () => {
    const repo = fixture({ 'packages/x/far.ts': 'export const far = 1;' }, { check: 'tsc --noEmit -p packages/x' });

    expect(derived(deriveClosure('bun run check', DERIVED, repo))).toContain('packages/x/far.ts');
  });

  test('a workspace package the resolver cannot enter is hashed whole', () => {
    const repo = fixture({
      'packages/vendored/package.json': JSON.stringify({ name: '@f/vendored', exports: { '.': { import: './dist/a.js' } } }),
      'packages/vendored/dist/a.js': 'export const a = 1;',
      'packages/vendored/dist/b.js': 'export const b = 1;',
      'scripts/g.ts': "import { a } from '@f/vendored';\nexport const g = a;",
    });

    const files = derived(deriveClosure('bun scripts/g.ts', DERIVED, repo));
    expect(files).toContain('packages/vendored/dist/a.js');
    expect(files).toContain('packages/vendored/dist/b.js');
  });

  test('literal environment reads enter the key, and a declared name joins them', () => {
    const repo = fixture({
      'scripts/g.ts': 'export const g = [process.env.ALPHA, Bun.env.BETA, process.env["GAMMA"]];',
    });

    const closure = deriveClosure('bun scripts/g.ts', { kind: 'derived', env: ['DELTA'] }, repo);
    expect(closure.kind === 'derived' ? closure.env : []).toEqual(['ALPHA', 'BETA', 'DELTA', 'GAMMA']);
  });

  test('a computed key bound to a same-file string constant is a literal read', () => {
    const repo = fixture({ 'scripts/g.ts': "const NAME = 'GAMMA';\nexport const OTHER = 'DELTA';\nexport const g = [process.env[NAME], process.env[OTHER]];" });
    const closure = deriveClosure('bun scripts/g.ts', DERIVED, repo);
    expect(closure.kind === 'derived' ? closure.env : ['refused']).toEqual(['DELTA', 'GAMMA']);
  });

  test('destructuring the environment reads exactly the named keys', () => {
    const repo = fixture({ 'scripts/g.ts': 'const { PATH, HOME } = process.env;\nexport const g = [PATH, HOME];' });
    const closure = deriveClosure('bun scripts/g.ts', DERIVED, repo);
    expect(closure.kind === 'derived' ? closure.env : ['refused']).toEqual(['HOME', 'PATH']);
  });

  test('a write to the environment is not a read', () => {
    const repo = fixture({
      'scripts/g.ts': "process.env.HOME = '/x';\ndelete process.env.OTHER;\nexport const g = 1;",
    });

    const closure = deriveClosure('bun scripts/g.ts', DERIVED, repo);
    expect(closure.kind === 'derived' ? closure.env : ['refused']).toEqual([]);
  });

  test('a declared read widens the closure by the tracked files it names', () => {
    const repo = fixture({
      'scripts/g.ts': "import { readFileSync } from 'node:fs';\nexport const g = readFileSync('fixtures/a.txt');",
      'fixtures/a.txt': 'a',
      'fixtures/b.txt': 'b',
    });

    const files = derived(deriveClosure('bun scripts/g.ts', { kind: 'derived', reads: ['fixtures/'] }, repo));
    expect(files).toContain('fixtures/a.txt');
    expect(files).toContain('fixtures/b.txt');
  });
});

describe('ladder-closure — red in every direction it refuses', () => {
  test('a live row is never derived', () => {
    const repo = fixture({ 'scripts/g.ts': 'export const g = 1;' });
    const closure = deriveClosure('bun scripts/g.ts', { kind: 'live', why: 'talks to the account' }, repo);
    expect(closure.kind).toBe('live');
  });

  test('a shell gate has no closure', () => {
    const repo = fixture({ 'scripts/g.sh': 'true' });
    expect(refused(deriveClosure('bash scripts/g.sh', DERIVED, repo))).toContain('shell gate');
  });

  test('a form the resolver does not understand has no closure', () => {
    const repo = fixture({});
    expect(refused(deriveClosure('make gate', DERIVED, repo))).toContain('does not understand');
    expect(refused(deriveClosure('bun run gate:absent', DERIVED, repo))).toContain('no package script');
  });

  test('a computed dynamic import or require refuses the gate until the row declares what it can load', () => {
    const repo = fixture({
      'scripts/g.ts': "const name = 'x';\nexport const g = () => import(`./${name}`);",
      'scripts/h.ts': "const name = 'x';\nexport const h = require(name);",
      'scripts/x.ts': 'export const x = 1;',
      'scripts/plain.ts': 'export const plain = 1;',
    });

    expect(refused(deriveClosure('bun scripts/g.ts', DECLARED, repo))).toContain('computed specifier');
    expect(refused(deriveClosure('bun scripts/h.ts', DECLARED, repo))).toContain('computed specifier');
    // Declared: the named files join the closure.
    const declared = deriveClosure('bun scripts/g.ts', { ...DECLARED, imports: ['scripts/x.ts'] }, repo);
    expect(derived(declared)).toContain('scripts/x.ts');
    // A declaration on a graph with no computed import is stale.
    expect(refused(deriveClosure('bun scripts/plain.ts', { ...DECLARED, imports: ['scripts/x.ts'] }, repo))).toContain('stale declaration');
    // A declaration naming nothing tracked is stale too.
    expect(refused(deriveClosure('bun scripts/g.ts', { ...DECLARED, imports: ['scripts/gone/'] }, repo))).toContain('matches no tracked file');
  });

  test('a local import that resolves to nothing refuses the gate', () => {
    const repo = fixture({ 'scripts/g.ts': "import { gone } from './gone';\nexport const g = gone;" });
    expect(refused(deriveClosure('bun scripts/g.ts', DECLARED, repo))).toContain('resolves to no parsed source');
  });

  test('an environment read whole refuses the gate whatever the row declares', () => {
    for (const body of [
      'export const g = { ...process.env };',
      'export const g = Object.entries(process.env);',
      'export const g = (env = process.env) => env;',
      "export const g = 'X' in Bun.env;",
      'const { PATH, ...rest } = process.env;\nexport const g = [PATH, rest];',
      "const k = 'X';\nconst { [k]: v } = process.env;\nexport const g = v;",
    ]) {
      const repo = fixture({ 'scripts/g.ts': body });
      expect(refused(deriveClosure('bun scripts/g.ts', DECLARED, repo))).toContain('reads the environment whole');
    }
  });

  test('a computed environment key needs a declared env list', () => {
    const repo = fixture({ 'scripts/g.ts': 'export const g = (k: string) => process.env[k];' });
    expect(refused(deriveClosure('bun scripts/g.ts', DERIVED, repo))).toContain('computed key');
    expect(deriveClosure('bun scripts/g.ts', { kind: 'derived', env: [] }, repo).kind).toBe('derived');
  });

  test('a read by path or a spawn needs a declared reads list, and a runtime resolve is a path read', () => {
    for (const body of [
      "import { readFileSync } from 'node:fs';\nexport const g = readFileSync('x');",
      "import { spawnSync } from 'child_process';\nexport const g = spawnSync('x');",
      "export const g = Bun.file('x');",
      "export const g = Bun.spawnSync(['x']);",
      "const s = 'x';\nexport const g = import.meta.resolve(s);",
    ]) {
      const repo = fixture({ 'scripts/g.ts': body });
      expect(refused(deriveClosure('bun scripts/g.ts', DERIVED, repo))).toContain('declares no `reads`');
      expect(deriveClosure('bun scripts/g.ts', { kind: 'derived', reads: [] }, repo).kind).toBe('derived');
    }
  });

  test('a declared read that matches nothing is a stale declaration', () => {
    const repo = fixture({ 'scripts/g.ts': 'export const g = 1;' });
    expect(refused(deriveClosure('bun scripts/g.ts', { kind: 'derived', reads: ['fixtures/'] }, repo)))
      .toContain('matches no tracked file');
  });

  test('a generated or untracked file in the closure refuses the gate', () => {
    const repo = fixture({
      'scripts/g.ts': "import { built } from '../dist/built';\nexport const g = built;",
      '.gitignore': 'dist/\n',
    });

    mkdirSync(join(repo.root, 'dist'));
    writeFileSync(join(repo.root, 'dist/built.ts'), 'export const built = 1;');


    // A gitignored file is outside the enumeration entirely, so the edge into
    // it is an unresolved import: refused, one rule earlier.
    expect(refused(deriveClosure('bun scripts/g.ts', DECLARED, repo))).toContain('resolves to no parsed source');
    // A TRACKED build directory is bytes git names, and stays an input.
    git(repo.root, 'add', '-f', 'dist/built.ts');
    git(repo.root, 'commit', '-qm', 'track the build');
    expect(derived(deriveClosure('bun scripts/g.ts', DECLARED, repoAt(repo.root, (run, tracked) => claims(run, tracked)))))
      .toContain('dist/built.ts');

    const untracked = fixture({ 'scripts/h.ts': "import { extra } from './extra';\nexport const h = extra;" });
    writeFileSync(join(untracked.root, 'scripts/extra.ts'), 'export const extra = 1;');
    const again = repoAt(untracked.root, (run, tracked) => claims(run, tracked));
    expect(refused(deriveClosure('bun scripts/h.ts', DECLARED, again))).toContain('generated or untracked');
  });

  test('a bun test gate that selects no file has no closure', () => {
    const repo = fixture({});
    expect(refused(deriveClosure('bun test packages/none/', DECLARED, repo))).toContain('no entry file');
  });
});
