#!/usr/bin/env bun
/**
 * The Python suites, run and PROVEN RUN.
 *
 * `bench/` ships three unittest suites over the shared KINU_HOME guard, the
 * model-endpoint adapter, the harbor corpus identity and the clbench event
 * mapping (84 tests executed on 2026-09-05; this gate prints the count on every
 * run). Without a runner that executes them they are invisible rather than
 * exempted: `scripts/ladder.test.ts` asserts every tracked test file is claimed
 * by some runner, and its denominator is `isRunnableSuite`, a JS/TS basename
 * rule. So "every test file is claimed" is a statement about TypeScript, and
 * three Python suites sit outside that sentence. `scripts/sources.ts` exports
 * `isPythonSuite`, which puts them in the denominator, and this is the runner
 * that answers for them.
 *
 * WHY IT IS NOT ONE `unittest discover`. Measured: `python3 -m unittest discover
 * -t . -s bench -p 'test_*.py'` reports `Ran 0 tests` and exits 0 — a silent
 * zero, the exact shape every gate here exists to refuse. `bench/tests`,
 * `bench/harbor/tests` and `bench/clbench/tests` carry no `__init__.py`, so
 * discovery will not recurse into them from a parent, and naming one as `-s`
 * with `-t .` raises `ImportError: Start directory is not importable`. The
 * invocation that works is `-s <dir> -t <dir>` per directory, and each suite's
 * own docstring documented the broken form. One process per root, and the roots
 * are DERIVED from the enumerated files rather than listed here: a new suite
 * directory joins this gate by existing.
 *
 * WHAT IT PROVES BEYOND EXIT ZERO. `unittest -v` names every test it ran as
 * `test_x (module.Class.test_x)`, so the set of MODULES that actually loaded is
 * readable from the output. That set is compared against the enumerated files.
 * A suite that stops being discovered — renamed past `test_*.py`, or made
 * unimportable so discovery reports it as a load error under a synthetic module
 * name — leaves its file in the claim and out of the execution, and this gate is
 * the only thing that can say so. `Ran N tests` alone cannot: a root that loaded
 * two of its three files still reports a healthy number.
 *
 * NO INTERPRETER IS A FAILURE, NOT A SKIP. A gate that reports green where it
 * could not run is the defect this repository has shipped most often. `bench/`
 * already requires `python3` (`scripts/tbench-arm.sh` drives
 * `python3 -m bench.harbor.corpus`), so the absence of one is a broken
 * environment and says so, non-zero.
 */

import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { assertMeasured, finding } from './gate-ratchet';
import { isPythonSuite, trackedFiles } from './sources';

const root = new URL('..', import.meta.url).pathname;

/** The interpreter, overridable for a pinned toolchain and nothing else. */
const PYTHON = process.env.KINU_PYTHON ?? 'python3';

/** What `unittest discover` selects, and what `isPythonSuite` accepts. The two
 *  halves of one claim, so a file this gate is credited with is a file the
 *  runner would load. */
const DISCOVER_PATTERN = 'test_*.py';

/** One discovery root and the suites enumerated under it. */
export interface SuiteRoot {
  /** Repo-relative directory, which is both `-s` and `-t`. */
  readonly directory: string;
  /** The module names discovery must report, derived from the tracked files. */
  readonly modules: readonly string[];
}

/**
 * The discovery roots, from the enumerated files. Sorted so a failure names
 * them in a stable order, and grouped by containing directory because that is
 * the unit `unittest discover` takes.
 */
export function suiteRoots(files: readonly string[]): readonly SuiteRoot[] {
  const byDirectory = new Map<string, string[]>();
  for (const file of files) {
    const directory = dirname(file);
    const module = file.slice(directory.length + 1).replace(/\.py$/, '');
    const existing = byDirectory.get(directory);
    if (existing === undefined) byDirectory.set(directory, [module]);
    else existing.push(module);
  }
  return [...byDirectory]
    .map(([directory, modules]): SuiteRoot => ({ directory, modules: modules.sort() }))
    .sort((left, right) => left.directory.localeCompare(right.directory));
}

/**
 * The modules a `unittest -v` transcript shows loaded.
 *
 * Verbose output is `test_name (module.Class.test_name) ... ok`, and a load
 * failure is `_FailedTest` under the module it could not import — which still
 * names the module, so a broken suite reports as a failure rather than as an
 * absence. Errors and skips carry the same shape, so this reads execution
 * rather than success; the exit code owns success.
 */
export function loadedModules(output: string): ReadonlySet<string> {
  const loaded = new Set<string>();
  for (const match of output.matchAll(/^\S+ \(([A-Za-z0-9_]+)\./gmu)) {
    if (match[1] !== undefined) loaded.add(match[1]);
  }
  return loaded;
}

/** The count `unittest` reports for one root, or `null` when it printed none. */
export function reportedCount(output: string): number | null {
  const match = /^Ran (\d+) tests? in /mu.exec(output);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * What this gate cannot see, printed on the GREEN path. A limitation visible
 * only in red output is invisible exactly when the tree is clean, which is
 * when somebody decides how far to trust the signal.
 */
export const BLIND_SPOTS: readonly string[] = [
  'TYPE ERRORS — NOT DETECTED. No Python typechecker runs in this repository, '
  + 'so a suite that passes unittest with a wrong-typed call passes here.',
  'PYTHON WITHOUT SUITES — OUT OF SCOPE. Only files the discovery pattern '
  + 'selects are governed. A bench helper no suite imports is invisible here.',
];

function main(): number {
  const files = trackedFiles().filter(isPythonSuite);
  const roots = suiteRoots(files);
  const measured = assertMeasured('python-suites', [
    ['suite files', files.length],
    ['discovery roots', roots.length],
  ]);

  const version = spawnSync(PYTHON, ['--version'], { cwd: root, encoding: 'utf8' });
  if (version.status !== 0) {
    console.error(finding({
      invariant: `${PYTHON} runs the tracked Python suites`,
      at: `${PYTHON} --version`,
      found: version.error === undefined
        ? `exited ${String(version.status)}`
        : `could not be spawned: ${version.error.message}`,
      silently: `${String(files.length)} tracked suites would go unrun, and a gate that cannot `
        + 'run must not report green — that is how three suites came to run in no pipeline',
      fix: 'install python3, or point KINU_PYTHON at the interpreter this checkout should use',
    }));
    return 1;
  }

  const findings: string[] = [];
  let executed = 0;
  for (const { directory, modules } of roots) {
    // `-t <dir>` as well as `-s <dir>`: with `-t .` these roots are not
    // importable and discovery raises rather than running.
    const run = spawnSync(
      PYTHON,
      ['-m', 'unittest', 'discover', '-v', '-s', directory, '-t', directory, '-p', DISCOVER_PATTERN],
      { cwd: root, encoding: 'utf8' },
    );
    const output = `${run.stdout}\n${run.stderr}`;
    const count = reportedCount(output);
    const loaded = loadedModules(output);
    const absent = modules.filter((module) => !loaded.has(module));
    console.log(
      `python-suites: ${directory} — ${String(count ?? 0)} test(s) across `
      + `${String(loaded.size)} module(s)`,
    );

    if (run.status !== 0) {
      console.error(output.trimEnd());
      findings.push(finding({
        invariant: 'every Python suite passes',
        at: directory,
        found: `unittest exited ${String(run.status)}`,
        silently: 'nothing — this is the failure the gate exists to surface. Its output is above',
        fix: `${PYTHON} -m unittest discover -v -s ${directory} -t ${directory} -p '${DISCOVER_PATTERN}'`,
      }));
      continue;
    }
    if (count === null || count === 0) {
      findings.push(finding({
        invariant: 'a discovery root runs at least one test',
        at: directory,
        found: count === null ? 'unittest printed no `Ran N tests` line' : 'Ran 0 tests',
        silently: 'exits 0. `unittest discover` over a directory it cannot import as a package '
          + 'reports NO TESTS RAN and succeeds, which is how `discover -t . -s bench` certified '
          + 'the whole of bench/ while running nothing',
        fix: `check that ${directory} holds files matching '${DISCOVER_PATTERN}' and that they import`,
      }));
      continue;
    }
    if (absent.length > 0) {
      findings.push(finding({
        invariant: 'every enumerated suite file is a module discovery loaded',
        at: `${directory}: ${absent.join(', ')}`,
        found: `discovery loaded ${[...loaded].sort().join(', ')}`,
        silently: 'the root still reports a healthy `Ran N tests`, so a suite that stopped being '
          + 'discovered leaves its file in this gate\'s claim and out of its execution',
        fix: `either the file no longer matches '${DISCOVER_PATTERN}' — rename it — or it fails to `
          + 'import, which discovery reports as a load error rather than as a missing file',
      }));
      continue;
    }
    executed += count;
  }

  if (findings.length > 0) {
    console.error(`\npython-suites: ${String(findings.length)} finding(s)\n`);
    for (const entry of findings) console.error(entry);
    return 1;
  }
  console.log(`python-suites: ok — ${measured}, ${String(executed)} tests executed`);
  for (const spot of BLIND_SPOTS) console.log(`  blind: ${spot}`);
  return 0;
}

if (import.meta.main) process.exit(main());
