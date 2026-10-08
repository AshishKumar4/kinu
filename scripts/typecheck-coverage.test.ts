import { describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { scratchDir } from '@kinu.run/test-utils';
import { childrenRunning } from './deadline';
import {
  checkedProjects,
  programFiles,
  runnableTestFiles,
  scriptDebtCoverage,
  scriptTypeScriptFiles,
  testCoverage,
} from './typecheck-coverage';

function configFixture(files: Readonly<Record<string, string>>) {
  const root = scratchDir('typecheck-coverage');

  for (const [file, content] of Object.entries(files)) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}

describe('checkedProjects', () => {
  test('follows `bun run <script>` transitively', () => {
    const projects = checkedProjects(JSON.stringify({
      scripts: {
        check: 'bun run lint && tsc --noEmit -p packages/core',
        lint: 'bun run test:anti-slop && oxlint',
        'test:anti-slop': 'tsc --noEmit -p tools/oxlint/anti-slop && node x.ts',
      },
    }));

    expect(projects).toEqual(['packages/core', 'tools/oxlint/anti-slop']);
  });

  test('terminates on a cyclic script reference instead of hanging', () => {
    const projects = checkedProjects(JSON.stringify({
      scripts: { check: 'bun run a', a: 'bun run b', b: 'bun run a && tsc --noEmit -p pkg' },
    }));

    expect(projects).toEqual(['pkg']);
  });

  test('leaves an empty check project list visible to the non-vacuity assertion', () => {
    expect(checkedProjects(JSON.stringify({ scripts: { check: 'echo hi' } }))).toEqual([]);
  });

  test('reads each script as the shell runs it, not as a -p anywhere in the text', () => {
    const projects = checkedProjects(JSON.stringify({
      scripts: {
        check: 'mkdir -p dist && bunx tsc --noEmit --project "packages/my pkg" \\\n  && bun run --silent lint',
        lint: 'tsc --noEmit -p tools/lint',
      },
    }));

    expect(projects).toEqual(['packages/my pkg', 'tools/lint']);
  });
});

describe('programFiles', () => {
  test('uses TypeScript fileNames for include, exclude, files, and references', async () => {
    const fixture = configFixture({
      'base.json': '{ "compilerOptions": { "strict": true } }',
      'include/tsconfig.json': '{ "extends": "../base.json", "include": ["included"], "exclude": ["included/excluded.test.ts"] }',
      'include/included/covered.test.ts': 'export const covered = true;\n',
      'include/included/excluded.test.ts': 'export const excluded = true;\n',
      'listed/tsconfig.json': '{ "files": ["only.test.ts"] }',
      'listed/only.test.ts': 'export const listed = true;\n',
      'listed/not-listed.test.ts': 'export const notListed = true;\n',
      'parent/tsconfig.json': '{ "files": [], "references": [{ "path": "../child" }] }',
      'child/tsconfig.json': '{ "compilerOptions": { "composite": true }, "files": ["referenced.test.ts"] }',
      'child/referenced.test.ts': 'export const referenced = true;\n',
    });

    try {
      expect(await programFiles(['include', 'listed', 'parent'], fixture.root)).toEqual([
        'include/included/covered.test.ts',
        'listed/only.test.ts',
      ]);
      expect(await programFiles(['include', 'listed', 'parent', 'child'], fixture.root)).toEqual([
        'child/referenced.test.ts',
        'include/included/covered.test.ts',
        'listed/only.test.ts',
      ]);
    } finally {
      fixture.remove();
    }
  });
});

describe('this tree', () => {
  test('governs every tracked runnable suite with exact program membership', async () => {
    const tests = runnableTestFiles();
    const programs = await programFiles();
    const coverage = testCoverage(tests, programs);

    expect(tests.length).toBeGreaterThan(0);
    expect(tests).toContain('tests/live-model/deep-evolution.test.ts');
    expect(tests).toContain('evals/tasks/chess.eval.ts');
    expect(coverage).toEqual({ governed: tests, missing: [], staleExceptions: [] });

    // This was excluded by the devbox config even though its sibling tests were
    // covered. Removing it from exact membership must fail, while the repaired
    // config has it in the compiler program.
    const devboxWorkspaceTest = 'packages/devbox/tests/workspace-resolution.test.ts';
    expect(programs).toContain(devboxWorkspaceTest);
    expect(testCoverage([devboxWorkspaceTest], programs.filter((file) => file !== devboxWorkspaceTest), {}).missing)
      .toEqual([devboxWorkspaceTest]);
  });

  test('has no undeclared or stale script typecheck debt, and leaves no compiler running', async () => {
    const programs = await programFiles();

    expect(scriptDebtCoverage(scriptTypeScriptFiles(), programs)).toEqual({ undeclared: [], stale: [] });
    // The compiler's API process outlived its close() and the file that ran it (2026-10-08).
    expect(childrenRunning(process.pid, '--api')).toEqual([]);
  });

  test('keeps the root tests and evals projects on the check path', () => {
    expect(checkedProjects()).toContain('tests');
    expect(checkedProjects()).toContain('evals');
  });
});
