// Credential-free verification of the bench runner: the isolation, seal, and
// anti-self-scoring guarantees, plus corpus validation. Runs no model and needs
// no provider — CI can gate on all of it.
import { describe, test, expect, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, lstatSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitOf } from '../packages/core/src/index.js';
import { DEFAULT_VALIDATE_RETRIES, parseArgv, parseCommon } from './bench.js';
import { BENCH_SUITES, loadBenchCorpus } from './bench-corpus.js';
import { assertScratchRoot, budgetSignal, createAttemptSandbox, restoreGuarded, sandboxEnv } from './bench-sandbox.js';

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
  const defect = patches.get('ema-alpha-weights')!;

  test('applies the defect and keeps the copy independent of the real repo', () => {
    const runRoot = tempDir('bench-sbx-');
    const sandbox = createAttemptSandbox({ repoRoot: REPO_ROOT, runRoot, attemptId: 'a1', defect });
    const target = 'packages/core/src/craft/ema.ts';
    expect(readFileSync(join(sandbox.dir, target), 'utf8')).not.toBe(readFileSync(join(REPO_ROOT, target), 'utf8'));

    writeFileSync(join(sandbox.dir, 'SCRATCH.txt'), 'solver wrote this');
    expect(existsSync(join(REPO_ROOT, 'SCRATCH.txt'))).toBe(false);
    sandbox.dispose();
    expect(existsSync(sandbox.dir)).toBe(false);
  });

  test('the task corpus is absent from the sandbox — a solver cannot read any task', () => {
    const runRoot = tempDir('bench-seal-');
    const sandbox = createAttemptSandbox({ repoRoot: REPO_ROOT, runRoot, attemptId: 'a2', defect });
    expect(existsSync(join(REPO_ROOT, 'tests', 'bench', 'tasks.jsonl'))).toBe(true);
    expect(existsSync(join(sandbox.dir, 'tests', 'bench'))).toBe(false);
    // The rest of tests/ is still there, so the checks can run.
    expect(existsSync(join(sandbox.dir, 'tests', 'eval'))).toBe(true);
    sandbox.dispose();
  });

  test('node_modules is a symlink, and .git is not copied', () => {
    const runRoot = tempDir('bench-nm-');
    const sandbox = createAttemptSandbox({ repoRoot: REPO_ROOT, runRoot, attemptId: 'a3', defect });
    expect(lstatSync(join(sandbox.dir, 'node_modules')).isSymbolicLink()).toBe(true);
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
    const sandbox = createAttemptSandbox({ repoRoot: REPO_ROOT, runRoot, attemptId: 'a6', defect });
    for (const link of ['packages/core/node_modules/@proteus/test-utils', 'packages/test-utils/node_modules/@proteus/core']) {
      const resolved = realpathSync(join(sandbox.dir, link));
      expect(resolved.startsWith(realpathSync(sandbox.dir))).toBe(true);
    }
    sandbox.dispose();
  });

  test('each attempt gets its own PROTEUS_HOME, and it is not the real one', () => {
    const runRoot = tempDir('bench-home-');
    const one = createAttemptSandbox({ repoRoot: REPO_ROOT, runRoot, attemptId: 'a4', defect });
    const two = createAttemptSandbox({ repoRoot: REPO_ROOT, runRoot, attemptId: 'a5', defect });
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
