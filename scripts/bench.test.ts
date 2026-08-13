// Credential-free verification of the bench runner: the isolation, seal, and
// anti-self-scoring guarantees, plus corpus validation. Runs no model and needs
// no provider — CI can gate on all of it.
import { describe, test, expect, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, lstatSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LONGHORIZON_ANSWER_FILE, buildLongHorizonQuestions, decodeLongHorizonSpec,
  encodeLongHorizonSpec, renderLongHorizonAnswerFile, splitOf,
} from '../packages/core/src/index.js';
import { BENCH_FAMILIES, DEFAULT_VALIDATE_RETRIES, panelArm, panelProviders, parseArgv, parseCommon } from './bench.js';
import { BENCH_SUITES, loadBenchCorpus } from './bench-corpus.js';
import { loadLongHorizonCorpus, materializeLongHorizon } from './bench-longhorizon.js';
import { applyPatch, assertScratchRoot, budgetSignal, createAttemptSandbox, restoreGuarded, sandboxEnv } from './bench-sandbox.js';

const REPO_ROOT = join(import.meta.dir, '..');
const scratch: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('parseArgv', () => {
  test('reads the command, valued flags, and bare flags', () => {
    const { command, args } = parseArgv(['compare', '--a', 'null', '--b', 'oracle', '--sealed']);
    expect(command).toBe('compare');
    expect(args.get('a')).toBe('null');
    expect(args.get('b')).toBe('oracle');
    expect(args.has('sealed')).toBe(true);
  });

  test('rejects a positional argument that is not the command', () => {
    expect(() => parseArgv(['compare', 'stray'])).toThrow(/unexpected argument/);
  });
});

describe('parseCommon — repeats and the validation retry budget', () => {
  const opts = (extra: Record<string, string> = {}) =>
    parseCommon(new Map(Object.entries({ 'run-root': tempDir('bench-opts-'), ...extra })));

  test('defaults to one attempt per task and a bounded validate retry', () => {
    const common = opts();
    expect(common.repeats).toBe(1);
    expect(common.validateRetries).toBe(DEFAULT_VALIDATE_RETRIES);
  });

  test('accepts a repeat count and zero retries', () => {
    expect(opts({ repeats: '3' }).repeats).toBe(3);
    expect(opts({ 'validate-retries': '0' }).validateRetries).toBe(0);
  });

  test('defaults to the defect family and refuses a corpus that does not exist', () => {
    expect(opts().family).toBe('defect');
    for (const family of BENCH_FAMILIES) expect(opts({ family }).family).toBe(family);
    expect(() => opts({ family: 'nope' })).toThrow(/--family must be one of/);
  });

  test('refuses counts that would silently change what is being measured', () => {
    // Zero repeats would produce an empty pass^k; a fractional one would run
    // floor(n) attempts while the config claimed n.
    expect(() => opts({ repeats: '0' })).toThrow(/--repeats must be an integer ≥ 1/);
    expect(() => opts({ repeats: '2.5' })).toThrow(/--repeats must be an integer ≥ 1/);
    expect(() => opts({ 'validate-retries': '-1' })).toThrow(/--validate-retries must be an integer ≥ 0/);
  });
});

describe('assertScratchRoot — the isolation promise, in code', () => {
  test('refuses a run root inside the real home', () => {
    expect(() => assertScratchRoot(join(homedir(), 'bench'), REPO_ROOT)).toThrow(/inside the real home/);
    expect(() => assertScratchRoot(homedir(), REPO_ROOT)).toThrow(/inside the real home/);
  });

  test('refuses a run root inside the repo under test', () => {
    // A repo outside $HOME, so the home guard cannot be what fires here.
    const repo = tempDir('bench-repo-');
    expect(() => assertScratchRoot(join(repo, 'runs'), repo)).toThrow(/inside the repo/);
    expect(() => assertScratchRoot(repo, repo)).toThrow(/inside the repo/);
  });

  test('accepts a throwaway root elsewhere', () => {
    expect(() => assertScratchRoot(tempDir('bench-ok-'), REPO_ROOT)).not.toThrow();
  });
});

describe('sandboxEnv', () => {
  test('strips inherited PROTEUS_* and redirects HOME to the attempt', () => {
    process.env.PROTEUS_HOME = '/real/home/.proteus';
    process.env.PROTEUS_AUTH = 'secret';
    try {
      const env = sandboxEnv('/attempt/home');
      expect(env.PROTEUS_HOME).toBe('/attempt/home');
      expect(env.HOME).toBe('/attempt/home');
      expect(env.PROTEUS_AUTH).toBeUndefined();
    } finally {
      delete process.env.PROTEUS_HOME;
      delete process.env.PROTEUS_AUTH;
    }
  });
});

describe('createAttemptSandbox', () => {
  const { patches } = loadBenchCorpus(REPO_ROOT);
  const prepare = (dir: string) => applyPatch(dir, patches.get('ema-alpha-weights')!, { reverse: false });

  test('applies the defect and keeps the copy independent of the real repo', () => {
    const runRoot = tempDir('bench-sbx-');
    const sandbox = createAttemptSandbox({ repoRoot: REPO_ROOT, runRoot, attemptId: 'a1', prepare });
    const target = 'packages/core/src/craft/ema.ts';
    expect(readFileSync(join(sandbox.dir, target), 'utf8')).not.toBe(readFileSync(join(REPO_ROOT, target), 'utf8'));

    writeFileSync(join(sandbox.dir, 'SCRATCH.txt'), 'solver wrote this');
    expect(existsSync(join(REPO_ROOT, 'SCRATCH.txt'))).toBe(false);
    sandbox.dispose();
    expect(existsSync(sandbox.dir)).toBe(false);
  });

  test('the task corpus is absent from the sandbox — a solver cannot read any task', () => {
    const runRoot = tempDir('bench-seal-');
    const sandbox = createAttemptSandbox({ repoRoot: REPO_ROOT, runRoot, attemptId: 'a2', prepare });
    expect(existsSync(join(REPO_ROOT, 'tests', 'bench', 'tasks.jsonl'))).toBe(true);
    expect(existsSync(join(sandbox.dir, 'tests', 'bench'))).toBe(false);
    // The rest of tests/ is still there, so the checks can run.
    expect(existsSync(join(sandbox.dir, 'tests', 'eval'))).toBe(true);
    sandbox.dispose();
  });

  // node_modules is mirrored, not symlinked wholesale: third-party deps stay
  // shared read-only (never copied — that is what keeps a sandbox off the
  // multi-gigabyte path), while the workspace scope is re-pointed at the copy.
  test('third-party deps are shared, and .git is not copied', () => {
    const runRoot = tempDir('bench-nm-');
    const sandbox = createAttemptSandbox({ repoRoot: REPO_ROOT, runRoot, attemptId: 'a3', prepare });
    const shared = join(sandbox.dir, 'node_modules', 'ai');
    expect(lstatSync(shared).isSymbolicLink()).toBe(true);
    expect(realpathSync(shared).startsWith(realpathSync(sandbox.dir))).toBe(false);
    expect(existsSync(join(sandbox.dir, '.git'))).toBe(false);
    sandbox.dispose();
  });

  // Existence is not the property that matters: a workspace link that still
  // RESOLVES to the pristine repo makes every cross-package import read the
  // source tree instead of the copy, so a solver's edits — and a task's defect —
  // are invisible to any test that imports through '@proteus/*'. This caught
  // facts-confidence-default-zero validating as "breaks nothing".
  test('workspace links resolve inside the copy, not back into the real repo', () => {
    const runRoot = tempDir('bench-ws-');
    const sandbox = createAttemptSandbox({ repoRoot: REPO_ROOT, runRoot, attemptId: 'a6', prepare });
    // Bun hoists workspace links to the ROOT node_modules — the per-package
    // paths this used to check have not existed for some time, so it ENOENTed
    // instead of catching the leak it was written to catch.
    for (const link of ['node_modules/@proteus/core', 'node_modules/@proteus/test-utils']) {
      const resolved = realpathSync(join(sandbox.dir, link));
      expect(resolved.startsWith(realpathSync(sandbox.dir))).toBe(true);
    }
    sandbox.dispose();
  });

  test('each attempt gets its own PROTEUS_HOME, and it is not the real one', () => {
    const runRoot = tempDir('bench-home-');
    const one = createAttemptSandbox({ repoRoot: REPO_ROOT, runRoot, attemptId: 'a4', prepare });
    const two = createAttemptSandbox({ repoRoot: REPO_ROOT, runRoot, attemptId: 'a5', prepare });
    expect(one.proteusHome).not.toBe(two.proteusHome);
    expect(one.proteusHome.startsWith(runRoot)).toBe(true);
    expect(one.proteusHome).not.toContain(join(homedir(), '.proteus'));
    one.dispose();
    two.dispose();
  });
});

describe('restoreGuarded — a solver cannot score itself', () => {
  test('reverts an edited test file and deletes one the solver added', () => {
    const pristine = tempDir('bench-pristine-');
    const sandbox = tempDir('bench-dirty-');
    for (const root of [pristine, sandbox]) {
      mkdirSync(join(root, 'pkg', 'tests'), { recursive: true });
      mkdirSync(join(root, 'pkg', 'src'), { recursive: true });
      writeFileSync(join(root, 'pkg', 'tests', 'a.test.ts'), 'original');
      writeFileSync(join(root, 'pkg', 'src', 'inline.test.ts'), 'original inline');
      writeFileSync(join(root, 'pkg', 'src', 'code.ts'), 'original code');
    }
    // A solver that tampers with the measuring apparatus:
    writeFileSync(join(sandbox, 'pkg', 'tests', 'a.test.ts'), 'expect(true).toBe(true)');
    writeFileSync(join(sandbox, 'pkg', 'src', 'inline.test.ts'), 'neutered');
    writeFileSync(join(sandbox, 'pkg', 'src', 'extra.test.ts'), 'added by the solver');
    writeFileSync(join(sandbox, 'pkg', 'src', 'code.ts'), 'the actual fix');

    restoreGuarded(sandbox, pristine, ['pkg/tests', 'pkg/src/**/*.test.ts']);

    expect(readFileSync(join(sandbox, 'pkg', 'tests', 'a.test.ts'), 'utf8')).toBe('original');
    expect(readFileSync(join(sandbox, 'pkg', 'src', 'inline.test.ts'), 'utf8')).toBe('original inline');
    expect(existsSync(join(sandbox, 'pkg', 'src', 'extra.test.ts'))).toBe(false);
    // The solver's real work survives — only the checks are restored.
    expect(readFileSync(join(sandbox, 'pkg', 'src', 'code.ts'), 'utf8')).toBe('the actual fix');
  });

  test('restores a guarded test file the solver deleted outright', () => {
    const pristine = tempDir('bench-p2-');
    const sandbox = tempDir('bench-d2-');
    for (const root of [pristine, sandbox]) {
      mkdirSync(join(root, 'pkg', 'tests'), { recursive: true });
      writeFileSync(join(root, 'pkg', 'tests', 'a.test.ts'), 'original');
    }
    rmSync(join(sandbox, 'pkg', 'tests'), { recursive: true, force: true });
    restoreGuarded(sandbox, pristine, ['pkg/tests']);
    expect(readFileSync(join(sandbox, 'pkg', 'tests', 'a.test.ts'), 'utf8')).toBe('original');
  });

  test('a guarded path missing from the pristine tree is an error, not a silent skip', () => {
    const pristine = tempDir('bench-p3-');
    const sandbox = tempDir('bench-d3-');
    expect(() => restoreGuarded(sandbox, pristine, ['nope'])).toThrow(/does not exist in the pristine tree/);
  });
});

describe('budgetSignal — the compute envelope is enforced, not advertised', () => {
  test('aborts once the wall-clock budget elapses', async () => {
    const budget = budgetSignal({ wallClockMs: 30, maxTokens: 1000 });
    expect(budget.timedOut()).toBe(false);
    expect(budget.signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(budget.timedOut()).toBe(true);
    expect(budget.signal.aborted).toBe(true);
    budget.done();
  });

  test('a solver that finishes in time is never marked as breaching', async () => {
    const budget = budgetSignal({ wallClockMs: 5000, maxTokens: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    budget.done();
    expect(budget.timedOut()).toBe(false);
    expect(budget.signal.aborted).toBe(false);
  });
});

describe('loadBenchCorpus', () => {
  test('loads the shipped corpus with a patch for every task', () => {
    const { corpus, patches } = loadBenchCorpus(REPO_ROOT);
    const all = [...corpus.dev.map((t) => t.id)];
    expect(corpus.dev.length + corpus.sealed.size).toBe(patches.size);
    expect(corpus.dev.length).toBeGreaterThan(0);
    expect(corpus.sealed.size).toBeGreaterThan(0);
    for (const id of all) expect(patches.get(id)).toContain('diff --git');
  });

  // A defect patch is data ABOUT source that keeps moving. When a refactor
  // renames the code a patch anchors on — or deletes it — the patch stops
  // applying and its task silently becomes unrunnable: `prepare` throws at
  // attempt time, long after anyone would connect it to the refactor. The
  // check is the same `git apply` the sandbox runs, so nothing can pass here
  // and fail there.
  test('every defect patch still applies to the tree it was seeded against', () => {
    const { patches } = loadBenchCorpus(REPO_ROOT);
    const stale = [...patches].filter(([, patch]) => Bun.spawnSync(
      ['git', 'apply', '--check', '--whitespace=nowarn', '-'],
      { cwd: REPO_ROOT, stdin: Buffer.from(patch), stdout: 'ignore', stderr: 'ignore' },
    ).exitCode !== 0).map(([id]) => id);
    expect(stale).toEqual([]);
  });

  test('every dev task really is dev — the split is derived, not declared', () => {
    const { corpus } = loadBenchCorpus(REPO_ROOT);
    for (const t of corpus.dev) expect(splitOf(t.id)).toBe('dev');
  });

  test('the held-out split is large enough to reach significance at all', () => {
    // 2·0.5^n ≤ 0.05 needs n ≥ 6. Below that no result on the seal can ever be
    // significant, and the harness could never accept anything.
    const { corpus } = loadBenchCorpus(REPO_ROOT);
    expect(corpus.sealed.size).toBeGreaterThanOrEqual(6);
  });

  test('tasks carry their suite\'s checks and guarded paths, not per-task copies', () => {
    const { corpus } = loadBenchCorpus(REPO_ROOT);
    const task = corpus.dev[0]!;
    expect(task.checks).toBe(BENCH_SUITES.core!.checks);
    expect(task.guarded).toBe(BENCH_SUITES.core!.guarded);
  });

  function fixtureRoot(line: string, opts: { patch?: string } = {}): string {
    const root = tempDir('bench-fixture-');
    mkdirSync(join(root, 'tests', 'bench', 'patches'), { recursive: true });
    writeFileSync(join(root, 'tests', 'bench', 'tasks.jsonl'), `${line}\n`);
    if (opts.patch !== undefined) writeFileSync(join(root, 'tests', 'bench', 'patches', 'demo.patch'), opts.patch);
    return root;
  }

  const goodLine = JSON.stringify({
    id: 'demo', title: 'demo', prompt: 'the suite fails; fix it',
    suite: 'core', editable: ['src/a.ts'],
  });

  test('refuses a task whose prompt quotes the fix', () => {
    const leaky = JSON.stringify({
      id: 'demo', title: 'demo',
      prompt: 'change it back to return (1 - alpha) * oldScore + alpha * newObs;',
      suite: 'core', editable: ['src/a.ts'],
    });
    const root = fixtureRoot(leaky, { patch: '--- a/x\n-  return (1 - alpha) * oldScore + alpha * newObs;\n+  return 0;\n' });
    expect(() => loadBenchCorpus(root)).toThrow(/quotes the fix/);
  });

  test('refuses a task with no defect patch', () => {
    expect(() => loadBenchCorpus(fixtureRoot(goodLine))).toThrow(/missing defect patch/);
  });

  test('refuses an unknown suite', () => {
    const line = JSON.stringify({ id: 'demo', title: 'd', prompt: 'p', suite: 'nope', editable: ['a'] });
    expect(() => loadBenchCorpus(fixtureRoot(line, { patch: 'x' }))).toThrow();
  });

  test('refuses an empty corpus — it proves nothing', () => {
    const root = tempDir('bench-empty-');
    mkdirSync(join(root, 'tests', 'bench', 'patches'), { recursive: true });
    writeFileSync(join(root, 'tests', 'bench', 'tasks.jsonl'), '# only a comment\n');
    expect(() => loadBenchCorpus(root)).toThrow(/no tasks/);
  });

  test('reports the line number for malformed JSON', () => {
    const root = fixtureRoot('{not json', { patch: 'x' });
    expect(() => loadBenchCorpus(root)).toThrow(/tasks\.jsonl:1/);
  });
});

describe('the long-horizon corpus', () => {
  const { corpus, specs, path } = loadLongHorizonCorpus(REPO_ROOT);

  test('loads with a generator spec for every task, in both shapes', () => {
    expect(corpus.dev.length + corpus.sealed.size).toBe(specs.size);
    expect(corpus.dev.length).toBeGreaterThan(0);
    expect(path.endsWith(join('tests', 'bench', 'longhorizon.jsonl'))).toBe(true);
    expect(new Set([...specs.values()].map((s) => s.shape))).toEqual(new Set(['digest', 'continuation']));
    for (const task of corpus.dev) expect(splitOf(task.id)).toBe('dev');
  });

  test('the held-out split is large enough to reach significance at all', () => {
    expect(corpus.sealed.size).toBeGreaterThanOrEqual(6);
  });

  test('a task carries its spec in the check argv, so the manifest covers the corpus size', () => {
    for (const task of corpus.dev) {
      const check = task.checks[0]!;
      expect(check.id).toBe('longhorizon-answers');
      expect(check.command.slice(0, 2)).toEqual(['bun', 'scripts/bench-longhorizon-check.ts']);
      expect(decodeLongHorizonSpec(check.command[2]!)).toEqual(specs.get(task.id)!);
    }
  });

  test('the checker and everything it imports are guarded — the apparatus cannot be edited', () => {
    for (const task of corpus.dev) {
      expect(task.guarded).toEqual(['scripts', 'packages/core/src']);
      expect(task.editable).toEqual([LONGHORIZON_ANSWER_FILE]);
    }
  });

  test('regenerating a task at a different size changes the manifest', () => {
    const bigger = loadLongHorizonCorpus(REPO_ROOT);
    expect(bigger.corpus.manifestHash).toBe(corpus.manifestHash);
    const [id, spec] = [...specs.entries()][0]!;
    expect(encodeLongHorizonSpec({ ...spec, entries: spec.entries + 1 }))
      .not.toBe(encodeLongHorizonSpec(specs.get(id)!));
  });

  function longHorizonFixture(line: unknown): string {
    const root = tempDir('bench-lh-fixture-');
    mkdirSync(join(root, 'tests', 'bench'), { recursive: true });
    writeFileSync(join(root, 'tests', 'bench', 'longhorizon.jsonl'), `${JSON.stringify(line)}\n`);
    return root;
  }

  test('refuses a spec that cannot produce a task', () => {
    const base = { id: 'demo', title: 'demo', shape: 'continuation', seed: 1, entries: 100, filler: 10 };
    expect(() => loadLongHorizonCorpus(longHorizonFixture({ ...base, markers: 2, parts: 4 })))
      .toThrow(/every part must plant at least one/);
    expect(() => loadLongHorizonCorpus(longHorizonFixture({ ...base, shape: 'digest', markers: 2, parts: 3 })))
      .toThrow(/digest shape has exactly one part/);
  });

  test('reports the line number for malformed JSON, and refuses an empty corpus', () => {
    const root = tempDir('bench-lh-empty-');
    mkdirSync(join(root, 'tests', 'bench'), { recursive: true });
    writeFileSync(join(root, 'tests', 'bench', 'longhorizon.jsonl'), '{not json\n');
    expect(() => loadLongHorizonCorpus(root)).toThrow(/longhorizon\.jsonl:1/);
    writeFileSync(join(root, 'tests', 'bench', 'longhorizon.jsonl'), '# only a comment\n');
    expect(() => loadLongHorizonCorpus(root)).toThrow(/no tasks/);
  });
});

// The instrument, end to end, without a sandbox or a model: materialize a
// task's corpus, write the answers a perfect solver would write, and let the
// REAL check command score it. An oracle that cannot pass and a null that can
// would both mean the family measures nothing.
describe('the long-horizon check scores what was actually materialized', () => {
  const { corpus, specs } = loadLongHorizonCorpus(REPO_ROOT);
  const task = corpus.dev.find((t) => specs.get(t.id)!.shape === 'continuation')!;
  const spec = specs.get(task.id)!;

  function runCheck(dir: string): number {
    const [, script, encoded] = task.checks[0]!.command;
    return Bun.spawnSync(['bun', join(REPO_ROOT, script!), encoded!], { cwd: dir, stdout: 'pipe', stderr: 'pipe' }).exitCode;
  }

  test('materializes every part, and the null control fails for want of an answer', () => {
    const dir = tempDir('bench-lh-null-');
    materializeLongHorizon(dir, spec);
    for (let part = 1; part <= spec.parts; part++) {
      expect(existsSync(join(dir, `bench-corpus/part-${part}`))).toBe(true);
    }
    expect(runCheck(dir)).toBe(1);
  });

  test('the oracle answer file passes; one wrong line fails the whole task', () => {
    const dir = tempDir('bench-lh-oracle-');
    materializeLongHorizon(dir, spec);
    const answers = renderLongHorizonAnswerFile(buildLongHorizonQuestions(spec));
    writeFileSync(join(dir, LONGHORIZON_ANSWER_FILE), answers);
    expect(runCheck(dir)).toBe(0);

    writeFileSync(join(dir, LONGHORIZON_ANSWER_FILE), answers.replace(/^q-count: .*$/m, 'q-count: 999999'));
    expect(runCheck(dir)).toBe(1);
  });

  test('deleting the corpus does not change the score — the answer key is not on disk', () => {
    const dir = tempDir('bench-lh-gone-');
    materializeLongHorizon(dir, spec);
    writeFileSync(join(dir, LONGHORIZON_ANSWER_FILE), renderLongHorizonAnswerFile(buildLongHorizonQuestions(spec)));
    rmSync(join(dir, 'bench-corpus'), { recursive: true, force: true });
    expect(runCheck(dir)).toBe(0);
  });
});

// A defect patch is a context diff against the source it was authored on, so an
// ordinary refactor elsewhere silently invalidates a task — and a corpus that
// no longer applies measures nothing. This caught the clade-selection refactor
// breaking archive-novelty-bonus. It is deliberately a fast `git apply --check`
// rather than a full `bench validate`: drift must fail on the same push that
// causes it, not overnight.
describe('the task corpus stays applicable to HEAD', () => {
  test('every defect patch applies cleanly to the current source', () => {
    const repo = join(import.meta.dir, '..');
    const dir = join(repo, 'tests', 'bench', 'patches');
    const stale = readdirSync(dir)
      .filter((f) => f.endsWith('.patch'))
      .filter((f) => Bun.spawnSync(
        ['git', 'apply', '--check', join(dir, f)],
        { cwd: repo, stdout: 'pipe', stderr: 'pipe' },
      ).exitCode !== 0);
    expect(stale).toEqual([]);
  });
});

/**
 * The panel arms. Both arms must take the same code path with the same panel
 * size — if `self` and `mixed` differed in anything but the provider list, the
 * comparison would measure that difference instead of panel composition.
 */
describe('panel arms — only the provider list may differ', () => {
  const analyst = { name: 'openai-compat', baseURL: 'http://a', headers: { Authorization: 'x' }, model: 'parent' };
  const withEnv = <T>(env: Record<string, string | undefined>, fn: () => T): T => {
    const prior = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try { return fn(); } finally { Object.assign(process.env, prior); }
  };

  test('a non-panel spec is not claimed, so it falls through to the other variants', () => {
    expect(panelArm('agent', analyst)).toBeNull();
    expect(panelArm('oracle', analyst)).toBeNull();
  });

  test('self runs the analyst model in every seat — today\'s inherit-the-parent default', () => {
    const arm = withEnv({ BENCH_PANEL_SIZE: '3' }, () => panelArm('panel:self', analyst));
    expect(arm!.panel).toHaveLength(3);
    for (const member of arm!.panel) expect(member.model).toBe('parent');
    // The analyst is held constant across arms, so it is the parent here too.
    expect(arm!.analyst.model).toBe('parent');
  });

  test('mixed runs one distinct model per seat, and the analyst stays the parent', () => {
    const arm = withEnv({
      BENCH_PANEL_SIZE: '3',
      BENCH_PANEL: 'http://a|k1|vendor-a;http://b|k2|vendor-b;http://c|k3|vendor-c',
    }, () => panelArm('panel:mixed', analyst));
    expect(arm!.panel.map((m) => m.model)).toEqual(['vendor-a', 'vendor-b', 'vendor-c']);
    expect(arm!.analyst.model).toBe('parent');
  });

  test('both arms are the same size, so the comparison is not confounded by panel width', () => {
    const env = { BENCH_PANEL_SIZE: '2', BENCH_PANEL: 'http://a|k1|vendor-a;http://b|k2|vendor-b' };
    const self = withEnv(env, () => panelArm('panel:self', analyst));
    const mixed = withEnv(env, () => panelArm('panel:mixed', analyst));
    expect(self!.panel).toHaveLength(mixed!.panel.length);
  });

  test('a mixed panel that cannot be built refuses rather than quietly running one model N times', () => {
    expect(() => withEnv({ BENCH_PANEL_SIZE: '3', BENCH_PANEL: 'http://a|k1|only-one' },
      () => panelArm('panel:mixed', analyst))).toThrow(/needs BENCH_PANEL with 3 entries/);
    expect(() => withEnv({ BENCH_PANEL_SIZE: '2', BENCH_PANEL: 'http://a|k1|a;malformed' },
      () => panelProviders(2))).toThrow(/must be "<baseURL>\|<auth>\|<model>"/);
  });

  test('panel size is bounded by what a fork panel actually accepts', () => {
    expect(() => withEnv({ BENCH_PANEL_SIZE: '1' }, () => panelArm('panel:self', analyst))).toThrow(/\[2,6\]/);
    expect(() => withEnv({ BENCH_PANEL_SIZE: '7' }, () => panelArm('panel:self', analyst))).toThrow(/\[2,6\]/);
  });
});
