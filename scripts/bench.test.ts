// Credential-free verification of the bench runner: the isolation, seal, and
// anti-self-scoring guarantees, plus corpus validation. Runs no model and needs
// no provider — CI can gate on all of it.
import { describe, test, expect, afterAll } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, lstatSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import {
  LONGHORIZON_ANSWER_FILE, buildLongHorizonQuestions, decodeLongHorizonSpec,
  encodeLongHorizonSpec, parseJsonValue, renderLongHorizonAnswerFile, SealedSplit, splitOf,
  type AttemptOutcome, type BenchTask, type JsonValue,
} from '../packages/core/src/index';
import { BENCH_FAMILIES, DEFAULT_VALIDATE_RETRIES, panelArm, panelProviders, parseArgv, parseCommon } from './bench';
import { BENCH_SUITES, benchPatchFiles, loadBenchCorpus, stalePatches } from './bench-corpus';
import { loadLongHorizonCorpus, materializeLongHorizon } from './bench-longhorizon';
import { applyPatch, assertScratchRoot, budgetSignal, createAttemptSandbox, restoreGuarded, sandboxEnv } from './bench-sandbox';
import {
  VALIDATION_DIAGNOSTICS_FILE, loadValidationDiagnostics, runValidation,
} from './bench-validation';
import {
  ARTIFACT_DIRNAME, assertDurableArtifactRoot, openRunRetention, readGitIdentity,
  readRetainedAttempts, resolveArtifactRoot,
} from './bench-retention';

import { parseAgentWorkerInput, parseWorkerOutput } from './bench-worker-protocol';
import { buildPilotReport, validatePilotReport } from './bench-pilot';

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

describe('bench worker protocol', () => {
  test('accepts the measured worker result shape', () => {
    expect(parseWorkerOutput(JSON.stringify({
      tokens: 23,
      steps: 2,
      hadError: false,
      budgetBreach: null,
      peakPromptTokens: 17,
      modelCalls: 0,
    }))).toEqual({
      tokens: 23,
      steps: 2,
      hadError: false,
      budgetBreach: null,
      peakPromptTokens: 17,
      modelCalls: 0,
    });
  });

  test('accepts a worker that measured nothing, rather than making it claim zero', () => {
    // What a crashed worker emits: it never reached its meter, so it states no
    // token figures at all. Under the old required schema the only encodable
    // answer was 0, which the harness then read as a free, in-budget attempt.
    const crashed = { steps: 0, hadError: true, budgetBreach: null, error: 'boom' };
    const parsed = parseWorkerOutput(JSON.stringify(crashed));
    expect(parsed).toEqual(crashed);
    expect(parsed.tokens).toBeUndefined();
    expect(parsed.peakPromptTokens).toBeUndefined();
  });

  test('rejects valid JSON with an invalid result shape', () => {
    expect(() => parseWorkerOutput(JSON.stringify({
      tokens: '23',
      steps: 2,
      hadError: false,
      budgetBreach: null,
      peakPromptTokens: 17,
    }))).toThrow(/invalid worker output/);
  });

  test('rejects non-finite usage instead of letting it disable the budget', () => {
    expect(() => parseWorkerOutput(JSON.stringify({
      tokens: Number.NaN,
      steps: 0,
      hadError: false,
      budgetBreach: null,
      peakPromptTokens: 0,
    }))).toThrow(/invalid worker output/);
  });

  test('strictly validates worker input and the parallel ask sequence', () => {
    const input = {
      dbPath: '/tmp/agent.db',
      workspaceName: 'bench',
      purpose: 'fix the task',
      asks: ['one'],
      removeAfterAsk: [null],
      maxTokens: 100,
      autoEvolve: false,
      llm: {
        name: 'workers-ai', baseURL: 'https://example.test/v1',
        headers: { Authorization: 'Bearer fake' }, model: '@cf/example/model',
      },
      sessionId: 'task',
    };
    expect(parseAgentWorkerInput(JSON.stringify(input)).sessionId).toBe('task');
    expect(() => parseAgentWorkerInput(JSON.stringify({ ...input, extra: true })))
      .toThrow(/invalid agent worker input/);
    expect(() => parseAgentWorkerInput(JSON.stringify({ ...input, removeAfterAsk: [] })))
      .toThrow(/equal length/);
  });
});

describe('stability pilot gate', () => {
  const taskIds = Array.from({ length: 40 }, (_, index) => `task-${index}`);
  const taskResults = taskIds.map((taskId, index) => ({
    taskId,
    attempts: 3,
    repeatIndices: [0, 1, 2],
    passes: index === 0 ? 2 : index === 1 ? 1 : index <= 20 ? 3 : 0,
    tokens: [12_000, 12_000, 12_000],
    modelCalls: [4, 5, 6],
    errors: 0,
    budgetBreaches: 0,
  }));
  const report = {
    schemaVersion: 2,
    kind: 'bench-stability-pilot',
    family: 'defect',
    manifestHash: 'manifest',
    variant: 'pi:vanilla',
    model: '@cf/zai-org/glm-5.2',
    providerHash: 'provider',
    budget: { wallClockMs: 300_000, maxTokens: 600_000 },
    seed: 7,
    tasks: 40,
    taskIds,
    taskResults,
    repeats: 3,
    attempts: 120,
    passed: 60,
    unstableTaskIds: ['task-0', 'task-1'],
    errors: 0,
    budgetBreaches: 0,
    meanTokens: 12_000,
    maxObservedTokens: 12_000,
    totalModelCalls: 600,
    meanModelCalls: 5,
    maxObservedModelCalls: 6,
  };

  test('accepts a completed one-arm 40 by 3 report for the same compute envelope', () => {
    expect(validatePilotReport(report, {
      family: 'defect',
      manifestHash: 'manifest',
      model: '@cf/zai-org/glm-5.2',
      providerHash: 'provider',
      budget: { wallClockMs: 300_000, maxTokens: 600_000 },
      comparedVariants: ['pi:vanilla', 'agent'],
    }).variant).toBe('pi:vanilla');
  });

  test('rejects an under-repeated or compute-mismatched pilot', () => {
    expect(() => validatePilotReport({ ...report, repeats: 2, attempts: 80 }, {
      family: 'defect', manifestHash: 'manifest', model: '@cf/zai-org/glm-5.2',
      providerHash: 'provider', budget: report.budget,
      comparedVariants: ['pi:vanilla', 'agent'],
    })).toThrow(/at least 3 repeats/);
    expect(() => validatePilotReport(report, {
      family: 'defect', manifestHash: 'manifest', model: '@cf/zai-org/glm-5.2',
      providerHash: 'provider', budget: { ...report.budget, maxTokens: 700_000 },
      comparedVariants: ['pi:vanilla', 'agent'],
    })).toThrow(/compute envelope/);
  });

  test('rejects pilot errors, budget breaches, and unrelated arms', () => {
    const expected = {
      family: 'defect' as const, manifestHash: 'manifest', model: '@cf/zai-org/glm-5.2',
      providerHash: 'provider', budget: report.budget,
      comparedVariants: ['pi:vanilla', 'agent'] as const,
    };
    const withError = report.taskResults.map((result, index) => index === 0 ? { ...result, errors: 1 } : result);
    const withBreach = report.taskResults.map((result, index) => index === 0 ? { ...result, budgetBreaches: 1 } : result);
    expect(() => validatePilotReport({ ...report, errors: 1, taskResults: withError }, expected)).toThrow(/worker error/);
    expect(() => validatePilotReport({ ...report, budgetBreaches: 1, taskResults: withBreach }, expected)).toThrow(/budget breach/);
    expect(() => validatePilotReport({ ...report, variant: 'agent-evolving' }, expected)).toThrow(/one of the compared arms/);
  });

  test('requires call-count evidence instead of treating absence as zero calls', () => {
    const withoutCalls = report.taskResults.map((result, index) => {
      if (index !== 0) return result;
      const { modelCalls: _modelCalls, ...rest } = result;
      return rest;
    });
    expect(() => validatePilotReport({ ...report, taskResults: withoutCalls }, {
      family: 'defect', manifestHash: 'manifest', model: '@cf/zai-org/glm-5.2',
      providerHash: 'provider', budget: report.budget,
      comparedVariants: ['pi:vanilla', 'agent'],
    })).toThrow(/invalid stability pilot report/);
  });

  test('builds exact call aggregates and rejects an uninstrumented attempt', () => {
    const outcome = (repeat: number, modelCalls: number): AttemptOutcome => ({
      taskId: 'task-0',
      variantId: 'pi:vanilla',
      slot: 'a',
      repeat,
      passed: true,
      checks: [],
      durationMs: 10,
      tokens: 100 + repeat,
      modelCalls,
      peakPromptTokens: 50,
      budgetBreach: null,
    });
    const input = {
      family: 'defect' as const,
      manifestHash: 'manifest',
      variant: 'pi:vanilla',
      llm: {
        name: 'workers-ai',
        baseURL: 'https://example.test/v1',
        headers: { Authorization: 'Bearer fake' },
        model: '@cf/zai-org/glm-5.2',
      },
      budget: report.budget,
      seed: 7,
      repeats: 2,
    };
    expect(buildPilotReport({ ...input, outcomes: [outcome(0, 0), outcome(1, 4)] }))
      .toMatchObject({
        totalModelCalls: 4, meanModelCalls: 2, maxObservedModelCalls: 4,
        meanTokens: 100.5, maxObservedTokens: 101,
      });
    const { modelCalls: _modelCalls, ...uninstrumented } = outcome(0, 0);
    expect(() => buildPilotReport({ ...input, outcomes: [uninstrumented] }))
      .toThrow(/no model-call evidence/);
    // Same posture for tokens: a pilot exists to say what a live variant costs,
    // so an unmeasured attempt is a hole in the measurement, not a cheap sample.
    const { tokens: _tokens, ...unmetered } = outcome(0, 0);
    expect(() => buildPilotReport({ ...input, outcomes: [unmetered] }))
      .toThrow(/no token measurement/);
  });

  test('covers both model-backed panel arms', () => {
    for (const variant of ['panel:self', 'panel:mixed']) {
      const result = Bun.spawnSync([
        'bun', join(REPO_ROOT, 'scripts', 'bench.ts'), 'compare',
        '--run-root', tempDir('bench-panel-pilot-'),
        '--a', variant,
        '--b', 'null',
        '--repeats', '3',
      ], { stdout: 'pipe', stderr: 'pipe' });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain('model-backed runs need --pilot-report');
    }
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

describe('artifact retention — a scored run leaves evidence or it does not run', () => {
  // `bench-artifacts/` is gitignored, so a fresh checkout or worktree does not
  // have one and every test below died on mkdtemp before it asserted anything.
  // Creating it is what the harness itself does; the tests may not assume an
  // operator ran a benchmark here first.
  const durableDir = (prefix: string): string => {
    mkdirSync(join(REPO_ROOT, ARTIFACT_DIRNAME), { recursive: true });
    const dir = mkdtempSync(join(REPO_ROOT, ARTIFACT_DIRNAME, prefix));
    scratch.push(dir);
    return dir;
  };
  const resolveRoot = (flag: string | undefined, env: string | undefined, runRoot: string): string =>
    resolveArtifactRoot({ flag, env: { BENCH_ARTIFACTS: env }, repoRoot: REPO_ROOT, runRoot });

  test('defaults into the repo, which .gitignore already reserves', () => {
    expect(resolveRoot(undefined, undefined, tempDir('bench-retention-run-')))
      .toBe(join(REPO_ROOT, ARTIFACT_DIRNAME));
  });

  test('refuses every swept root, because that is how the R3 evidence was lost', () => {
    const runRoot = tempDir('bench-retention-run-');
    for (const swept of ['/tmp/kinu-bench', '/var/tmp/kinu-bench', '/dev/shm/kinu-bench', join(tmpdir(), 'x')]) {
      expect(() => resolveRoot(swept, undefined, runRoot)).toThrow(/which is swept/);
      expect(() => resolveRoot(undefined, swept, runRoot)).toThrow(/which is swept/);
    }
  });

  test('refuses the run root, whose sandboxes the run itself deletes', () => {
    // Not under a swept root, so this exercises the containment rule itself
    // rather than tripping the swept-root rule first.
    const runRoot = durableDir('retain-runroot-');
    expect(() => assertDurableArtifactRoot(join(runRoot, 'artifacts'), runRoot)).toThrow(/inside the run root/);
    expect(() => assertDurableArtifactRoot('relative/path', runRoot)).toThrow(/must be absolute/);
  });

  test('has no off switch: an empty value is an error, not an opt-out', () => {
    const runRoot = tempDir('bench-retention-run-');
    expect(() => resolveRoot('', undefined, runRoot)).toThrow(/retention cannot be switched off/);
    expect(() => resolveRoot(undefined, '  ', runRoot)).toThrow(/retention cannot be switched off/);
  });

  const provenance = (taskIds: readonly string[]) => ({
    command: 'compare',
    runId: 'fixture01',
    family: 'defect',
    corpus: 'tests/bench/tasks.jsonl (random 2 of 159, seed 7)',
    manifestHash: 'fixture-manifest',
    seed: 7,
    repeats: 1,
    budget: { wallClockMs: 1000, maxTokens: 10 },
    variants: ['agent', 'agent-evolving'],
    evolving: true,
    model: '@cf/deepseek-ai/deepseek-v4-pro-0813',
    providerHash: 'fixture-endpoint',
    taskIds,
  });

  const attempt = (taskId: string, variantId: string, passed: boolean): AttemptOutcome => ({
    taskId, variantId, slot: variantId === 'agent' ? 'a' : 'b', repeat: 0, passed,
    checks: [{ id: 'core-tests', passed, exitCode: passed ? 0 : 1, durationMs: 12, output: 'tail' }],
    durationMs: 34, tokens: 56, peakPromptTokens: 78, budgetBreach: null,
  });

  test('records the commit, the model, the corpus, the task list and every trial', () => {
    const artifactRoot = durableDir('retain-ok-');
    const retention = openRunRetention({
      artifactRoot, repoRoot: REPO_ROOT, provenance: provenance(['task-a', 'task-b']),
    });
    retention.recordAttempt(attempt('task-a', 'agent', false));
    retention.recordAttempt(attempt('task-a', 'agent-evolving', true));

    // Read BEFORE finish: a run that dies mid-flight must still have its trials.
    expect(readRetainedAttempts(retention.dir).map((o) => [o.taskId, o.variantId, o.passed]))
      .toEqual([['task-a', 'agent', false], ['task-a', 'agent-evolving', true]]);
    expect(parseJsonValue(readFileSync(join(retention.dir, 'run.json'), 'utf8'))).toMatchObject({
      completedAt: null,
      commit: readGitIdentity(REPO_ROOT).commit,
      model: '@cf/deepseek-ai/deepseek-v4-pro-0813',
      corpus: 'tests/bench/tasks.jsonl (random 2 of 159, seed 7)',
      evolving: true,
      taskIds: ['task-a', 'task-b'],
    });
    expect(readGitIdentity(REPO_ROOT).commit).toMatch(/^[0-9a-f]{40}$/);

    retention.recordAttempt(attempt('task-b', 'agent', true));
    retention.finish({ headline: 'fixture' });
    expect(parseJsonValue(readFileSync(join(retention.dir, 'run.json'), 'utf8'))).toMatchObject({
      completedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      report: { headline: 'fixture' },
      perTask: [
        { taskId: 'task-a', byVariant: { agent: { attempts: 1, passed: 0 }, 'agent-evolving': { attempts: 1, passed: 1 } } },
        { taskId: 'task-b', byVariant: { agent: { attempts: 1, passed: 1 } } },
      ],
    });
  });

  test('proves the root writable rather than assuming it', () => {
    const parent = durableDir('retain-readonly-');
    const artifactRoot = join(parent, 'nested');
    chmodSync(parent, 0o500);
    try {
      expect(() => openRunRetention({ artifactRoot, repoRoot: REPO_ROOT, provenance: provenance(['task-a']) }))
        .toThrow(/is not writable, so this scored run would leave no evidence/);
    } finally {
      chmodSync(parent, 0o700);
    }
  });

  test('a scored run pointed at a swept root fails before it spends anything', () => {
    const result = Bun.spawnSync([
      'bun', join(REPO_ROOT, 'scripts', 'bench.ts'), 'validate',
      '--run-root', tempDir('bench-retention-e2e-'),
      '--artifacts', join(tmpdir(), 'kinu-bench-swept'),
      '--limit', '1',
    ], { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('which is swept');
    // Nothing ran: the refusal is at argument parsing, ahead of the first sandbox.
    expect(result.stderr.toString()).not.toContain('Validating');
    expect(existsSync(join(tmpdir(), 'kinu-bench-swept'))).toBe(false);
  });
});

describe('validation diagnostics', () => {
  const task = (id: string): BenchTask => ({
    id,
    title: id,
    prompt: 'repair the defect',
    editable: ['src/code.ts'],
    guarded: ['tests'],
    checks: [{ id: 'core-tests', command: ['false'] }],
  });

  const outcome = (
    taskId: string,
    side: 'broken' | 'oracle',
    repeat: number,
    passed: boolean,
    output: string,
  ): AttemptOutcome => ({
    taskId,
    variantId: side === 'broken' ? 'null' : 'oracle',
    slot: side === 'broken' ? 'a' : 'b',
    repeat,
    passed,
    checks: [{ id: 'core-tests', passed, exitCode: passed ? 0 : 1, durationMs: 654_321, output }],
    durationMs: 987_654,
    tokens: 765_432,
    modelCalls: 4_321,
    peakPromptTokens: 54_321,
    budgetBreach: null,
  });

  test('retains fail-then-pass attempt outputs for dev and sealed without stdout leakage', async () => {
    const runRoot = tempDir('bench-validation-diagnostics-');
    const dev = task('dev-diagnostic');
    const sealed = task('sealed-diagnostic');
    const stdout: string[] = [];

    const summary = await runValidation({
      family: 'defect',
      corpusPath: '/fixture/tasks.jsonl',
      manifestHash: 'fixture-manifest',
      validateRetries: 1,
      diagnosticsDir: runRoot,
      devTasks: [dev],
      sealed: new SealedSplit([sealed]),
      runAttempt: async (current, repeat) => ({
        broken: outcome(current.id, 'broken', repeat, false, `${current.id}-broken-${repeat}`),
        oracle: outcome(current.id, 'oracle', repeat, repeat === 1, `${current.id}-oracle-${repeat}`),
      }),
      log: (line) => stdout.push(line),
    });

    expect(summary).toEqual({ total: 2, badIds: [], flakyIds: [dev.id, sealed.id], ok: true });
    const diagnostics = loadValidationDiagnostics(join(runRoot, VALIDATION_DIAGNOSTICS_FILE));
    expect(diagnostics.attempts.map(({ taskId, split, attempt }) => ({ taskId, split, attempt }))).toEqual([
      { taskId: dev.id, split: 'dev', attempt: 1 },
      { taskId: dev.id, split: 'dev', attempt: 2 },
      { taskId: sealed.id, split: 'sealed', attempt: 1 },
      { taskId: sealed.id, split: 'sealed', attempt: 2 },
    ]);
    expect(diagnostics.attempts.flatMap(({ broken, oracle }) => [broken.checks[0]!.output, oracle.checks[0]!.output])).toEqual([
      'dev-diagnostic-broken-0', 'dev-diagnostic-oracle-0',
      'dev-diagnostic-broken-1', 'dev-diagnostic-oracle-1',
      'sealed-diagnostic-broken-0', 'sealed-diagnostic-oracle-0',
      'sealed-diagnostic-broken-1', 'sealed-diagnostic-oracle-1',
    ]);
    expect(stdout.join('\n')).not.toContain('diagnostic-broken');
    expect(stdout.join('\n')).not.toContain('diagnostic-oracle');
    for (const diagnosticValue of ['654321', '987654', '765432', '4321', '54321']) {
      expect(stdout.join('\n')).not.toContain(diagnosticValue);
    }
    expect(lstatSync(join(runRoot, VALIDATION_DIAGNOSTICS_FILE)).mode & 0o777).toBe(0o600);
    expect(readdirSync(runRoot).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  test('rejects an unvalidated diagnostic document instead of laundering extra fields', () => {
    const path = join(tempDir('bench-invalid-validation-diagnostics-'), VALIDATION_DIAGNOSTICS_FILE);
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      kind: 'bench-validation-diagnostics',
      family: 'defect',
      corpusPath: '/fixture/tasks.jsonl',
      manifestHash: 'fixture-manifest',
      validateRetries: 1,
      attempts: [],
      unvalidated: true,
    }));
    expect(() => loadValidationDiagnostics(path)).toThrow(/invalid validation diagnostics/);
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
  test('strips inherited KINU_* and redirects HOME to the attempt', () => {
    process.env.KINU_HOME = '/real/home/.kinu';
    process.env.KINU_AUTH = 'secret';
    try {
      const env = sandboxEnv('/attempt/home');
      expect(env.KINU_HOME).toBe('/attempt/home');
      expect(env.HOME).toBe('/attempt/home');
      expect(env.KINU_AUTH).toBeUndefined();
    } finally {
      delete process.env.KINU_HOME;
      delete process.env.KINU_AUTH;
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

  test('retained evidence is absent too — the seal has a second ring now', () => {
    // A retained run holds per-trial outcomes and check output for SEALED tasks.
    // Copying bench-artifacts/ into the sandbox would hand a solver the held-out
    // answers by a route that excluding tests/bench does not cover.
    const runRoot = tempDir('bench-seal-artifacts-');
    const leak = mkdtempSync(join(REPO_ROOT, ARTIFACT_DIRNAME, 'seal-probe-'));
    scratch.push(leak);
    writeFileSync(join(leak, 'attempts.jsonl'), '{"taskId":"a-sealed-task"}\n');
    const sandbox = createAttemptSandbox({ repoRoot: REPO_ROOT, runRoot, attemptId: 'a7', prepare });
    expect(existsSync(join(REPO_ROOT, ARTIFACT_DIRNAME))).toBe(true);
    expect(existsSync(join(sandbox.dir, ARTIFACT_DIRNAME))).toBe(false);
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
  // are invisible to any test that imports through '@kinu.run/*'. This caught
  // facts-confidence-default-zero validating as "breaks nothing".
  test('workspace links resolve inside the copy, not back into the real repo', () => {
    const runRoot = tempDir('bench-ws-');
    const sandbox = createAttemptSandbox({ repoRoot: REPO_ROOT, runRoot, attemptId: 'a6', prepare });
    // Bun hoists workspace links to the ROOT node_modules — the per-package
    // paths this used to check have not existed for some time, so it ENOENTed
    // instead of catching the leak it was written to catch.
    for (const link of ['node_modules/@kinu.run/core', 'node_modules/@kinu.run/test-utils']) {
      const resolved = realpathSync(join(sandbox.dir, link));
      expect(resolved.startsWith(realpathSync(sandbox.dir))).toBe(true);
    }
    sandbox.dispose();
  });

  test('each attempt gets its own KINU_HOME, and it is not the real one', () => {
    const runRoot = tempDir('bench-home-');
    const one = createAttemptSandbox({ repoRoot: REPO_ROOT, runRoot, attemptId: 'a4', prepare });
    const two = createAttemptSandbox({ repoRoot: REPO_ROOT, runRoot, attemptId: 'a5', prepare });
    expect(one.kinuHome).not.toBe(two.kinuHome);
    expect(one.kinuHome.startsWith(runRoot)).toBe(true);
    expect(one.kinuHome).not.toContain(join(homedir(), '.kinu'));
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
    const all = corpus.dev.map((t) => t.id);
    expect(corpus.dev.length + corpus.sealed.size).toBe(patches.size);
    expect(corpus.dev.length).toBeGreaterThan(0);
    expect(corpus.sealed.size).toBeGreaterThan(0);
    for (const id of all) expect(patches.get(id)).toContain('diff --git');
  });

  // A defect patch is data ABOUT source that keeps moving. When a refactor
  // renames the code a patch anchors on — or deletes it — the patch stops
  // applying and its task silently becomes unrunnable: `prepare` throws at
  // attempt time, long after anyone would connect it to the refactor.
  //
  // ONE CENSUS, not two. This property was asserted twice in this file by two
  // different enumerations — the corpus-loaded patches here and a directory walk
  // further down — which meant either could pass while the other failed and
  // neither named which direction it owned. `stalePatches` does both and labels
  // the difference (`orphan`), and `gate:bench-corpus` holds the same census at
  // COMMIT tier, so nothing can pass here and fail there either.
  test('every defect patch still applies to the tree it was seeded against', () => {
    expect(stalePatches(REPO_ROOT, benchPatchFiles())).toEqual([]);
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

  test('loads with a generator spec for every task, in both modes', () => {
    expect(corpus.dev.length + corpus.sealed.size).toBe(specs.size);
    expect(corpus.dev.length).toBeGreaterThan(0);
    expect(path.endsWith(join('tests', 'bench', 'longhorizon.jsonl'))).toBe(true);
    expect(new Set([...specs.values()].map((spec) => spec.mode))).toEqual(new Set(['digest', 'continuation']));
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

  function longHorizonFixture(line: JsonValue): string {
    const root = tempDir('bench-lh-fixture-');
    mkdirSync(join(root, 'tests', 'bench'), { recursive: true });
    writeFileSync(join(root, 'tests', 'bench', 'longhorizon.jsonl'), `${JSON.stringify(line)}\n`);
    return root;
  }

  test('refuses a spec that cannot produce a task', () => {
    const base = { id: 'demo', title: 'demo', mode: 'continuation', seed: 1, entries: 100, filler: 10 };
    expect(() => loadLongHorizonCorpus(longHorizonFixture({ ...base, markers: 2, parts: 4 })))
      .toThrow(/every part must plant at least one/);
    expect(() => loadLongHorizonCorpus(longHorizonFixture({ ...base, mode: 'digest', markers: 2, parts: 3 })))
      .toThrow(/digest mode has exactly one part/);
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
  const task = corpus.dev.find((task_) => specs.get(task_.id)!.mode === 'continuation')!;
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
// breaking archive-novelty-bonus, and the census below caught the `--id` change
// in this very branch breaking sealed-validate-flags-the-good-tasks.
//
// Applicability itself is now proved at COMMIT tier by `gate:bench-corpus`, over
// the same `stalePatches` census — drift fails on the machine that caused it
// rather than after a push. What is left here is the property that census makes
// checkable and neither earlier enumeration named: a patch file the corpus does
// not measure.
describe('the task corpus stays applicable to HEAD', () => {
  // An orphan patch is reachable ONLY by the directory walk — the corpus-loaded
  // enumeration never loads a file no `tasks.jsonl` line names — and it is the
  // state a half-finished retirement leaves behind. `retired.jsonl`'s own test
  // below asserts the inverse, where a patch file's ABSENCE is the claim.
  test('no patch file sits outside the corpus that measures it', () => {
    expect(stalePatches(REPO_ROOT, benchPatchFiles()).filter((p) => p.orphan)).toEqual([]);
    const named = new Set(loadBenchCorpus(REPO_ROOT).patches.keys());
    const files = readdirSync(join(REPO_ROOT, 'tests', 'bench', 'patches'))
      .filter((f) => f.endsWith('.patch'))
      .map((f) => f.slice(0, -'.patch'.length));
    expect(files.filter((id) => !named.has(id))).toEqual([]);
  });

  // The only sanctioned answer to a patch that can never apply again: the code
  // it was data about is gone. Recording it keeps that indistinguishable-by-
  // inspection case apart from dropping a task the tree got worse at, and keeps
  // the dev/sealed accounting reconstructable from the ledger alone.
  const RetiredEntry = v.object({
    id: v.pipe(v.string(), v.minLength(1)),
    split: v.picklist(['dev', 'sealed']),
    retiredAt: v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/)),
    /** The code the task was data about, named precisely enough to check. */
    subject: v.pipe(v.string(), v.minLength(1)),
    /** The commit that removed that code — the claim, made checkable. */
    removedBy: v.pipe(v.string(), v.regex(/^[0-9a-f]{7,40}$/)),
    reason: v.pipe(v.string(), v.minLength(1)),
  });

  test('every retired task is recorded, gone, and honestly split', () => {
    const dir = join(import.meta.dir, '..', 'tests', 'bench');
    const entries = readFileSync(join(dir, 'retired.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('#'))
      .map((l) => v.parse(RetiredEntry, JSON.parse(l)));
    expect(entries.length).toBeGreaterThan(0);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);

    const live = new Set(loadBenchCorpus(join(import.meta.dir, '..')).patches.keys());
    for (const e of entries) {
      // A retired id must be absent from the corpus AND leave no orphan patch,
      // or `loadBenchCorpus` would still be carrying it.
      expect(live.has(e.id)).toBe(false);
      expect(existsSync(join(dir, 'patches', `${e.id}.patch`))).toBe(false);
      // Re-derived, never trusted: a misreported split would silently rewrite
      // how much held-out evidence the corpus is claimed to have had.
      expect(e.split).toBe(splitOf(e.id));
    }
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

describe('the evolution-event vocabulary does not drift across languages', () => {
  // bench/clbench/kinu/events.py must know which activity-channel events are
  // really evolution, and it cannot import TypeScript. So the set is duplicated
  // once, deliberately, and this is the gate that stops the copy from rotting.
  // Without it, an event type added to core would silently stop counting as
  // evolution in both external benchmark adapters -- which is exactly how a run
  // comes to report that the mechanism under test did not fire when it did.
  const readSource = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

  test('every EvolutionEvent type is classified as evolution by the Python reader', () => {
    const union = /export interface EvolutionEvent \{\s*type:\s*([^;]+);/
      .exec(readSource('packages/core/src/evolution/types.ts'));
    expect(union).not.toBeNull();
    const fromCore = [...union![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(fromCore.length).toBeGreaterThan(5);

    // The two shadow-eval outcomes local-session.ts emits directly, not via the
    // engine's listener, so they are absent from the union above.
    const session = readSource('packages/cli-backend/src/local-session.ts');
    const direct = ['scaffold_promotion', 'scaffold_rollback'];
    for (const name of direct) expect(session).toContain(`'${name}'`);

    const python = readSource('bench/clbench/kinu/events.py');
    const block = /EVOLUTION_EVENTS = frozenset\(\{([\s\S]*?)\}\)/.exec(python);
    expect(block).not.toBeNull();
    const fromPython = [...block![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);

    expect([...fromPython].sort()).toEqual([...new Set([...fromCore, ...direct])].sort());
  });

  test('the activity-channel events that are NOT evolution stay out of the set', () => {
    // Measured from the 2026-08-10 Terminal-Bench 2.1 artifacts: 7 events on the
    // activity channel of a trial configured evolve=false, all bg_job_started.
    // Each exclusion names its live emitter, so the set excludes real traffic
    // rather than a hypothesis.
    const emitters = {
      bg_job_started: 'packages/core/src/jobs/runner.ts',
      bg_jobs_settling: 'packages/cli-backend/src/local-session.ts',
      bg_jobs_abandoned: 'packages/cli-backend/src/local-session.ts',
      system_prompt_hash: 'packages/cli-backend/src/local-session.ts',
      mcp: 'packages/cf-backend/src/actor-agent.ts',
    };
    const block = /EVOLUTION_EVENTS = frozenset\(\{([\s\S]*?)\}\)/
      .exec(readSource('bench/clbench/kinu/events.py'))![1]!;
    for (const [notEvolution, emitter] of Object.entries(emitters)) {
      expect(block).not.toContain(`"${notEvolution}"`);
      expect(readSource(emitter)).toContain(`'${notEvolution}'`);
    }
  });
});
