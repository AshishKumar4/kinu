/**
 * The Python suite runner's own decision logic, proven RED in every direction.
 *
 * The gate exists because three suites — 77 tests when it was written — ran in
 * no pipeline at all, and because the obvious fix reproduces the defect: a
 * single `unittest discover -t . -s bench` reports `Ran 0 tests` and exits 0.
 * So the two things this gate adds over an exit code are a non-empty root and a
 * MODULE-LEVEL comparison, and both are driven from fixture transcripts here
 * rather than from a live run.
 */
import { describe, expect, test } from 'bun:test';
import { loadedModules, reportedCount, suiteRoots } from './python-suites';
import { isPythonSuite, trackedFiles } from './sources';

/** A real `unittest -v` transcript shape: `name (module.Class.name) ... ok`. */
const VERBOSE = `test_guard_rejects (test_isolation.KinuHomeGuard.test_guard_rejects) ... ok
test_guard_accepts (test_isolation.KinuHomeGuard.test_guard_accepts) ... ok
test_endpoint (test_model_endpoint.Endpoint.test_endpoint) ... skipped 'no key'

----------------------------------------------------------------------
Ran 3 tests in 0.004s

OK (skipped=1)
`;

describe('what the transcript proves', () => {
  test('every module discovery loaded is named, skips and all', () => {
    expect([...loadedModules(VERBOSE)].sort()).toEqual(['test_isolation', 'test_model_endpoint']);
  });

  test('a load failure still names its module, so a broken suite is not an absence', () => {
    // `unittest` reports an unimportable file as `_FailedTest` UNDER the module
    // it could not import, which is the whole reason this reads execution rather
    // than success: a suite that stopped importing must show up as present and
    // failing, never as quietly missing.
    const failed = 'test_corpus (unittest.loader._FailedTest.test_corpus) ... ERROR\n';
    expect([...loadedModules(failed)]).toEqual(['unittest']);
  });

  test('a NO TESTS RAN transcript yields no modules and no count', () => {
    // The measured silent zero: `discover -t . -s bench` over directories with no
    // `__init__.py` prints exactly this and exits 0.
    const empty = '\n----------------------------------------------------------------------\nRan 0 tests in 0.000s\n\nNO TESTS RAN\n';
    expect([...loadedModules(empty)]).toEqual([]);
    expect(reportedCount(empty)).toBe(0);
  });

  test('the count is read from the line unittest actually prints', () => {
    expect(reportedCount(VERBOSE)).toBe(3);
    expect(reportedCount('Ran 1 test in 0.001s\n')).toBe(1);
    // No line at all is distinguishable from zero: one is a crash before the
    // summary, the other is a root that discovered nothing, and the gate's
    // finding says which.
    expect(reportedCount('Traceback (most recent call last):\n')).toBeNull();
  });
});

describe('the discovery roots come from the enumeration', () => {
  test('files are grouped by the directory `discover` takes as both -s and -t', () => {
    expect(suiteRoots([
      'bench/tests/test_isolation.py',
      'bench/tests/test_model_endpoint.py',
      'bench/harbor/tests/test_corpus.py',
    ])).toEqual([
      { directory: 'bench/harbor/tests', modules: ['test_corpus'] },
      { directory: 'bench/tests', modules: ['test_isolation', 'test_model_endpoint'] },
    ]);
  });

  test('the module name is the basename discovery will import it under', () => {
    expect(suiteRoots(['a/b/test_x.py'])[0]?.modules).toEqual(['test_x']);
  });

  test('an empty enumeration yields no roots, which `assertMeasured` then refuses', () => {
    expect(suiteRoots([])).toEqual([]);
  });

  test('the roots it derives are the ones on disk, and there is more than one', () => {
    // Cross-checked against the tree rather than asserted as a literal: this is
    // the claim the gate makes, and a count would drift the moment a fourth
    // suite directory landed.
    const roots = suiteRoots(trackedFiles().filter(isPythonSuite));
    expect(roots.length).toBeGreaterThan(1);
    expect(roots.every((root) => root.modules.length > 0)).toBe(true);
    const directories = roots.map((root) => root.directory);
    expect(directories).toEqual([...directories].sort());
  });
});
