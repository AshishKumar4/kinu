#!/usr/bin/env bun
/**
 * Every runnable test is either an exact root file of a TypeScript program that
 * `bun run check` invokes, or a named exception. Directory-prefix matching is
 * deliberately not enough: a config can exclude one file inside an otherwise
 * covered directory, which was how `scripts/eval.test.ts` and the devbox
 * workspace-resolution guard went green without ever reaching the compiler.
 */

import { readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { API } from 'typescript/unstable/async';
import * as v from 'valibot';
import { assertMeasured, finding } from './gate-ratchet';
import { isRunnableSuite, trackedFiles } from './sources';

const root = new URL('..', import.meta.url).pathname;

type TestException =
  | {
    readonly kind: 'JavaScript test';
    readonly runner: string;
    readonly reason: string;
  }
  | {
    readonly kind: 'declared compiler debt';
    readonly runner: string;
    readonly reason: string;
  }
  | {
    readonly kind: 'standalone config';
    readonly config: string;
    readonly runner: string;
    readonly reason: string;
  };

const EVAL_TEST_DEBT = 'The test and its CLI bridge incompatible eval and scaffold JudgeFn '
  + 'shapes (TS2322 and TS2339) until those public contracts converge.';

/** The only scripts/*.ts files deliberately outside every checked program. */
export const SCRIPT_TYPECHECK_DEBT = {
  'scripts/eval.ts': 'The CLI adapts incompatible eval and scaffold JudgeFn shapes (TS2322).',
  'scripts/eval.test.ts': EVAL_TEST_DEBT,
  'scripts/layergate.ts':
    'The compaction-ladder substitution has a Fault<PipelineSubjects> variance error (TS2322).',
  'scripts/cli-test-runner.ts': 'One call supplies two arguments to a one-argument function (TS2554).',
  'scripts/schema-drift.ts': 'A string index has an implicit-any error (TS7053).',
} as const satisfies Readonly<Record<string, string>>;

/**
 * Every exception is a file, not a directory, so a new test cannot inherit one
 * accidentally. Its row is stale as soon as a checked program owns the file.
 */
export const UNTYPECHECKED_TESTS = {
  'packages/pc-agent/tests/daemon.test.js': {
    kind: 'JavaScript test',
    runner: 'bun test packages/pc-agent/',
    reason: 'The package is plain JavaScript. `check` syntax-checks its source with node --check.',
  },
  'packages/pc-agent/tests/sandbox.test.js': {
    kind: 'JavaScript test',
    runner: 'bun test packages/pc-agent/',
    reason: 'The package is plain JavaScript. `check` syntax-checks its source with node --check.',
  },
  'packages/pc-agent/tests/pty.test.js': {
    kind: 'JavaScript test',
    runner: 'bun test packages/pc-agent/',
    reason: 'The package is plain JavaScript. `check` syntax-checks its source with node --check.',
  },
  'packages/pc-agent/tests/pty-protocol.test.js': {
    kind: 'JavaScript test',
    runner: 'bun test packages/pc-agent/',
    reason: 'The package is plain JavaScript. `check` syntax-checks its source with node --check.',
  },
  'scripts/eval.test.ts': {
    kind: 'declared compiler debt',
    runner: 'bun test scripts/eval.test.ts',
    reason: EVAL_TEST_DEBT,
  },
} as const satisfies Readonly<Record<string, TestException>>;

/** The tracked files a test runner selects, repo-relative. */
export function runnableTestFiles(files: readonly string[] = trackedFiles()): string[] {
  return files.filter(isRunnableSuite).sort();
}

/** The scripts project's TypeScript inputs, including tests and fixture workers. */
export function scriptTypeScriptFiles(files: readonly string[] = trackedFiles()): string[] {
  return files.filter((file) => file.startsWith('scripts/') && file.endsWith('.ts')).sort();
}

/**
 * The tsconfig projects `bun run check` passes to tsc, following `bun run`
 * references transitively. The list is derived from the command that actually
 * runs rather than duplicated here.
 */
export function checkedProjects(
  packageJson = readFileSync(resolve(root, 'package.json'), 'utf8'),
): string[] {
  const scripts = v.parse(
    v.object({ scripts: v.record(v.string(), v.string()) }),
    JSON.parse(packageJson),
  ).scripts;

  const projects = new Set<string>();
  const visited = new Set<string>();
  const walk = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    const body = scripts[name];
    if (body === undefined) return;
    for (const match of body.matchAll(/-p\s+(\S+)/g)) {
      if (match[1] !== undefined) projects.add(match[1]);
    }
    for (const match of body.matchAll(/bun run\s+([\w:.-]+)/g)) {
      if (match[1] !== undefined) walk(match[1]);
    }
  };
  walk('check');
  return [...projects].sort();
}

function configPath(project: string, repoRoot: string): string {
  return resolve(repoRoot, project.endsWith('.json') ? project : join(project, 'tsconfig.json'));
}

/**
 * The exact union of `fileNames` TypeScript resolves for every checked project.
 * `parseConfigFile` is the compiler's resolver: it handles extends, include,
 * exclude and files. A referenced config is not folded in here, because `tsc
 * -p` does not compile its references; it must be separately reached by check.
 */
export async function programFiles(
  projects: readonly string[] = checkedProjects(),
  repoRoot = root,
): Promise<string[]> {
  const compiler = new API();
  const fileNames = new Set<string>();
  try {
    for (const project of projects) {
      const parsed = await compiler.parseConfigFile(configPath(project, repoRoot));
      for (const fileName of parsed.fileNames) {
        fileNames.add(relative(repoRoot, fileName).split(sep).join('/'));
      }
    }
  } finally {
    await compiler.close();
  }
  return [...fileNames].sort();
}

/**
 * What this gate cannot see, printed on the GREEN path. A limitation visible
 * only in red output is invisible exactly when the tree is clean, which is
 * when somebody decides how far to trust the signal.
 */
export const BLIND_SPOTS: readonly string[] = [
  'WHETHER THE TESTS IN A COVERED DIRECTORY ASSERT ANYTHING — NOT MEASURED. '
  + 'This gate proves each runnable suite reaches the compiler. A suite that '
  + 'compiles and asserts nothing passes here.',
];

export interface TestCoverage {
  readonly governed: readonly string[];
  readonly missing: readonly string[];
  readonly staleExceptions: readonly string[];
}

/** Compare the measured runnable-test set with exact program membership. */
export function testCoverage(
  tests: readonly string[],
  typechecked: readonly string[],
  exceptions: Readonly<Record<string, TestException>> = UNTYPECHECKED_TESTS,
): TestCoverage {
  const programs = new Set(typechecked);
  const declared = new Set(Object.keys(exceptions));
  return {
    governed: tests.filter((file) => programs.has(file) || declared.has(file)),
    missing: tests.filter((file) => !programs.has(file) && !declared.has(file)),
    staleExceptions: [...declared]
      .filter((file) => !tests.includes(file) || programs.has(file))
      .sort(),
  };
}

export interface ScriptDebtCoverage {
  readonly undeclared: readonly string[];
  readonly stale: readonly string[];
}

/** The five debt rows are the exact untypechecked set of scripts/*.ts inputs. */
export function scriptDebtCoverage(
  scripts: readonly string[],
  typechecked: readonly string[],
): ScriptDebtCoverage {
  const programs = new Set(typechecked);
  const untyped = scripts.filter((file) => !programs.has(file));
  return {
    undeclared: untyped.filter((file) => !Object.hasOwn(SCRIPT_TYPECHECK_DEBT, file)),
    stale: Object.keys(SCRIPT_TYPECHECK_DEBT).filter((file) => !untyped.includes(file)).sort(),
  };
}

function exceptionRowProblems(
  exceptions: Readonly<Record<string, TestException>> = UNTYPECHECKED_TESTS,
): string[] {
  const problems: string[] = [];
  for (const [file, row] of Object.entries(exceptions)) {
    if (row.runner.trim() === '' || row.reason.trim() === '') {
      problems.push(`${file}: an exception needs both a runner and a reason`);
    }
    if (row.kind === 'declared compiler debt' && !Object.hasOwn(SCRIPT_TYPECHECK_DEBT, file)) {
      problems.push(`${file}: compiler-debt test exception is not a declared script-debt row`);
    }
    if (row.kind === 'standalone config' && row.config.trim() === '') {
      problems.push(`${file}: standalone-config exception has no config`);
    }
  }
  return problems;
}

async function main(): Promise<number> {
  const tests = runnableTestFiles();
  const scripts = scriptTypeScriptFiles();
  const projects = checkedProjects();
  const typechecked = await programFiles(projects);
  const coverage = testCoverage(tests, typechecked);
  const debt = scriptDebtCoverage(scripts, typechecked);
  const exceptionProblems = exceptionRowProblems();
  const measured = assertMeasured('typecheck-coverage', [
    ['tracked runnable test files', tests.length],
    ['scripts TypeScript files', scripts.length],
    ['projects in `check`', projects.length],
    ['exact compiler fileNames', typechecked.length],
  ]);

  if (
    coverage.missing.length === 0
    && coverage.staleExceptions.length === 0
    && debt.undeclared.length === 0
    && debt.stale.length === 0
    && exceptionProblems.length === 0
    && coverage.governed.length === tests.length
  ) {
    console.log(
      `typecheck-coverage: ok — measured ${String(tests.length)} runnable test files = governed `
      + `${String(coverage.governed.length)} exact program-or-exception rows (${measured})`,
    );
    for (const spot of BLIND_SPOTS) console.log(`  blind: ${spot}`);
    return 0;
  }

  for (const file of coverage.missing) {
    console.error(finding({
      invariant: 'every tracked runnable test file is an exact member of a TypeScript program `bun run check` runs',
      at: file,
      found: `absent from the compiler fileNames union for ${projects.join(', ')}`,
      silently: 'a config can include this directory while excluding this file, so directory-prefix coverage '
        + 'reports green while this test never reaches the compiler',
      fix: 'add the file to a checked tsconfig. Only a JavaScript test, declared red compiler debt, or '
        + 'standalone config with a real runner and reason may receive an exact exception row.',
    }));
  }
  for (const file of coverage.staleExceptions) {
    console.error(`typecheck-coverage: stale test exception ${file} is no longer needed or is not runnable`);
  }
  for (const file of debt.undeclared) {
    console.error(finding({
      invariant: 'the scripts compiler-debt list is the exact set of untypechecked scripts/*.ts files',
      at: file,
      found: 'the file is absent from every checked compiler fileNames union without a debt row',
      silently: 'a new scripts tsconfig exclusion can otherwise make a gate or its test silently stop typechecking',
      fix: 'typecheck the file through `bun run check`, or add a named debt row only for an existing compiler error.',
    }));
  }
  for (const file of debt.stale) {
    console.error(`typecheck-coverage: stale script-debt row ${file} is now typechecked or no longer exists`);
  }
  for (const problem of exceptionProblems) console.error(`typecheck-coverage: invalid test exception ${problem}`);
  return 1;
}

if (import.meta.main) process.exit(await main());
