// The existing dispatch suite now exercises native armada dispatch; no GitHub implementation or shim remains.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';
import { EVAL_MAP_POOL, EVAL_TASK_TIMEOUT_SECONDS, EVAL_TRIAL_CALLS, MUSE_CALLS_AT_ONCE, evalMatrix } from '../evals/src/config';
import { parseResults, trials } from '../evals/src/results';
import { whyIncomplete } from '../evals/src/comparison';
import { evalItems, evalMapArgv, evalTaskFiles } from './evals-map';
import { joinTrialReports, selectTrialReport, type TrialItem } from './evals-artifacts';
import { ciVerdictRow } from './ci-verdicts';

const MATRIX = evalMatrix({ KINU_EVAL_TRIALS: '2' }, ['product']);

const ORIGINS = [{ leg: 'candidate', origin: 'https://staging.kinu.run' }, { leg: 'baseline', origin: 'https://kinu.run' }] as const;

const ITEMS = evalItems(['evals/tasks/chess.eval.ts', 'evals/tasks/swarm.eval.ts'], MATRIX, ORIGINS, false);

function caseReport(item: TrialItem, status = 'passed') {
  return {
    name: `/repo/evals/tasks/${item.task}.eval.ts`, startTime: 100, endTime: 200,
    assertionResults: [{ title: `${item.model} | ${item.arm} | trial ${String(item.trial)}`, status, duration: 100,
      meta: { harness: { run: {
        session: { metadata: { taskId: item.task, taskVersion: 'version', evalCommit: 'definitions', productSha: 'abcdef1', arm: item.arm, trial: item.trial } },
        usage: { model: item.model },
        output: { metrics: { modelTurns: 1, toolCalls: 0, toolErrors: 0, badInputCalls: 0, unknownToolCalls: 0, providerWaits: 0, providerWaitMs: 0 },
          turns: [{ part: 'build', turn: 1, outcome: { status: 'completed' }, checks: [{ id: 'answers', pass: status === 'passed' }] }] },
        errors: [],
      } } },
    }],
  };
}

describe('parallel armada evaluations', () => {
  test('the requested task matrix comes from the tracked population and rejects unknown or duplicate cells', () => {
    const all = ['evals/tasks/office.eval.ts', 'evals/tasks/swarm.eval.ts'];

    expect(evalTaskFiles(all, undefined)).toEqual(all);
    expect(evalTaskFiles(all, 'swarm')).toEqual(['evals/tasks/swarm.eval.ts']);
    expect(() => evalTaskFiles(all, 'missing')).toThrow('distinct tasks');
    expect(() => evalTaskFiles(all, 'office,office')).toThrow('distinct tasks');
  });

  test('two tasks times two trials on both legs produces eight distinct cells with their origins and whole slot matrix', () => {
    expect(ITEMS).toHaveLength(8);
    expect(new Set(ITEMS.map((item) => `${item.leg}/${item.task}/${item.model}/${item.arm}/${String(item.trial)}`)).size).toBe(8);

    for (const item of ITEMS) {
      expect(item.origin).toBe(item.leg === 'candidate' ? 'https://staging.kinu.run' : 'https://kinu.run');
      expect(item.trials).toBe(2);
      expect(item.models).toEqual([...MATRIX.models]);
      expect(item.arms).toEqual([...MATRIX.arms]);
    }
  });

  test('the single map reserves peak calls, not an average and not a pool per leg', () => {
    expect(EVAL_MAP_POOL).toBe(3);
    expect(EVAL_MAP_POOL * EVAL_TRIAL_CALLS).toBeLessThanOrEqual(MUSE_CALLS_AT_ONCE);
    expect((EVAL_MAP_POOL + 1) * EVAL_TRIAL_CALLS).toBeGreaterThan(MUSE_CALLS_AT_ONCE);
    expect(EVAL_TASK_TIMEOUT_SECONDS).toBe(6 * 60 * 60);
  });

  test('the supported CLI names Kinu\'s connection and its sole artifact extraction path', () => {
    const argv = evalMapArgv('abcdef123456', '/tmp/evals', ['KINU_EVAL_STAGING_WEB_IDENTITY', 'KINU_EVAL_WEB_IDENTITY']);

    expect(argv[0]).toContain('node_modules/.bin/armada');
    expect(argv[1]).toBe('map');
    expect(argv).toContain('--commit=abcdef123456');
    expect(argv).toContain('--pool=3');
    expect(argv).toContain('--timeout=21600');
    expect(argv).toContain('--json');
    expect(argv).toContain('--artifacts=/tmp/evals/trials');
    expect(argv.find((word) => word.startsWith('--connection='))).toMatch(/armada-kinu\.json$/u);
    expect(argv).toContain('--secrets=KINU_EVAL_STAGING_WEB_IDENTITY,KINU_EVAL_WEB_IDENTITY');
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual(['bun', 'evals/scripts/trial.ts']);
  });

  test('Vitest selection strips skipped cases, anchors trial one, and rejects the wrong or duplicated case', () => {
    const item = ITEMS[0];

    if (item === undefined) throw new Error('the pilot matrix is empty');

    const report = caseReport(item);

    report.assertionResults.push({ ...report.assertionResults[0], title: `${item.model} | ${item.arm} | trial 10`, status: 'skipped' });

    const selected = selectTrialReport(JSON.stringify({ testResults: [report] }), item);

    expect(trials(parseResults('trial', selected))).toHaveLength(1);
    expect(trials(parseResults('trial', selected))[0]?.meta.harness.run.session.metadata.trial).toBe(1);
    expect(() => selectTrialReport(selected, { ...item, trial: 2 })).toThrow('expected one');
    expect(() => selectTrialReport(JSON.stringify({ testResults: [report, report] }), item)).toThrow('expected one');
  });

  test('per-trial artifacts merge by file; missing and duplicate trials stay incomplete instead of invented outcomes', () => {
    const dir = scratchDir('eval-artifact-merge');
    const candidate = ITEMS.filter((item) => item.leg === 'candidate');

    const reports = candidate.map((item, index) => {
      const path = join(dir, `${String(index)}.json`);

      writeFileSync(path, selectTrialReport(JSON.stringify({ testResults: [caseReport(item)] }), item));

      return { item, path, failure: '' };
    });

    const joined = joinTrialReports(reports);
    const options = { trials: 2, taskFiles: ['evals/tasks/chess.eval.ts', 'evals/tasks/swarm.eval.ts'], build: 'abcdef1' };

    expect(parseResults('joined', joined)).toHaveLength(2);
    expect(trials(parseResults('joined', joined))).toHaveLength(4);
    expect(whyIncomplete(joined, options)).toBeNull();
    expect(whyIncomplete(joinTrialReports(reports.slice(1)), options)).not.toBeNull();
    expect(whyIncomplete(joinTrialReports([...reports, ...reports.slice(0, 1)]), options)).toContain('expected 1 to 2 once each');
    const first = reports[0];

    if (first === undefined) throw new Error('no pilot report');

    const lost = joinTrialReports([{ item: first.item, failure: 'armada wall exit 124' }, ...reports.slice(1)]);

    expect(trials(parseResults('lost', lost))).toHaveLength(3);
    expect(lost).toContain('armada wall exit 124');
    expect(whyIncomplete(lost, options)).not.toBeNull();
  });

  test('the deploy ladder artifact copier retains evidence paths declared in a row, without renaming the trial', () => {
    const root = scratchDir('eval-evidence-copy');
    const dir = join(root, 'source');
    const artifacts = join(root, 'artifacts');
    const evidence = 'evals-chess-123/model/product/chess-trial-1/ledger.jsonl';

    mkdirSync(join(dir, 'evals-chess-123/model/product/chess-trial-1'), { recursive: true });
    writeFileSync(join(dir, evidence), '{"type":"run_start"}\n');
    writeFileSync(join(dir, 'results.json'), '{"testResults":[]}');
    const row = ciVerdictRow({ run: 'trial', evidence: 'evals' }, { exitCode: 0, seconds: 1, stdout: '', stderr: '' }, undefined, { dir, artifacts });

    expect(row.artifacts).toContain(`evals/${evidence}`);
    expect(row.artifacts).toContain('evals/results.json');
    expect(readFileSync(join(artifacts, 'evals', evidence), 'utf8')).toBe('{"type":"run_start"}\n');
  });
});
