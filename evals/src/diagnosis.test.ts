import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { parseDiagnosis, renderDiagnosis } from './diagnosis';
import { extractInsights } from './insights';
import { assertion as makeAssertion, end, evidence as makeEvidence, missingFile, start } from './fixtures/insight-evidence';
import type { Assertion } from './results';

const assertion = makeAssertion();

const evidence = makeEvidence([start, missingFile, end]);

const reviews = [{ id: 'trial-1', insights: extractInsights(assertion, evidence) }];

const reply = { verdict: { value: 'unchanged', reason: 'Comparable pass counts did not change.' }, trials: [{
  id: 'trial-1', cause: { kind: 'agent:tool-misuse', tool: 'file' }, explanation: 'The lead used a relative slate path.',
  evidence: [{ file: 'ledger.jsonl', line: 2 }], fix: 'docs/TOOLS.md: clarify the workspace root.',
}] };

describe('the advisory diagnosis contract', () => {
  test('unknown or multiple causes and extra reply fields cannot produce a diagnosis', () => {
    const first = reply.trials[0];

    if (first === undefined) throw new Error('reply has no trial');

    for (const cause of [{ kind: 'model error' }, [{ kind: 'harness' }, { kind: 'agent:wrong-answer' }],
      { kind: 'agent:orchestration', problem: 'bad delegation' }]) {
      expect(() => parseDiagnosis(JSON.stringify({ ...reply, trials: [{ ...first, cause }] }), 'unchanged', reviews)).toThrow(v.ValiError);
    }

    expect(() => parseDiagnosis(JSON.stringify({ ...reply, unsolicited: 'comment' }), 'unchanged', reviews)).toThrow(v.ValiError);
  });

  test('every failed trial must be diagnosed exactly once, with no invented id', () => {
    expect(() => parseDiagnosis(JSON.stringify({ ...reply, trials: [] }), 'unchanged', reviews)).toThrow(v.ValiError);
    expect(() => parseDiagnosis(JSON.stringify({ ...reply, trials: [...reply.trials, ...reply.trials] }), 'unchanged', reviews)).toThrow(v.ValiError);
    expect(() => parseDiagnosis(JSON.stringify(reply), 'unchanged', reviews.map((review) => ({ ...review, id: 'other' })))).toThrow(v.ValiError);
  });

  test('a diagnosis cannot change the verdict or invent a tool or evidence line', () => {
    const first = reply.trials[0];

    if (first === undefined) throw new Error('reply has no trial');

    expect(() => parseDiagnosis(JSON.stringify(reply), 'regressed', reviews)).toThrow(v.ValiError);
    expect(() => parseDiagnosis(JSON.stringify({ ...reply, trials: [{ ...first, cause: { kind: 'agent:tool-misuse', tool: 'unseen' } }] }), 'unchanged', reviews)).toThrow(v.ValiError);
    expect(() => parseDiagnosis(JSON.stringify({ ...reply, trials: [{ ...first, evidence: [{ file: 'ledger.jsonl', line: 10000 }] }] }), 'unchanged', reviews)).toThrow(v.ValiError);
    expect(() => parseDiagnosis(JSON.stringify({ ...reply, trials: [{ ...first, evidence: [] }] }), 'unchanged', reviews)).toThrow(v.ValiError);
  });

  test('an empty ledger has no line 1 to cite when a workspace failed before recording events', () => {
    const first = reply.trials[0];

    if (first === undefined) throw new Error('reply has no trial');

    const empty = [{ id: 'trial-1', insights: extractInsights(assertion, { ledger: '', timeline: '', transcript: '' }) }];
    const diagnosis = { ...reply, trials: [{ ...first, cause: { kind: 'harness' }, evidence: [{ file: 'ledger.jsonl', line: 1 }] }] };
    expect(() => parseDiagnosis(JSON.stringify(diagnosis), 'unchanged', empty)).toThrow(v.ValiError);
  });

  test('Markdown fences and a heading followed by arbitrary prose are not an in-shape reply', () => {
    expect(() => parseDiagnosis(`\`\`\`json\n${JSON.stringify(reply)}\n\`\`\``, 'unchanged', reviews)).toThrow(SyntaxError);
    expect(() => parseDiagnosis('## Why the evals failed\nThe tool was confusing.', 'unchanged', reviews)).toThrow(SyntaxError);
  });

  test('counts each cause per task/model/arm, with passing trials still in the denominators', () => {
    const first: Assertion = { ...assertion, meta: { harness: { run: { ...assertion.meta.harness.run,
      usage: { ...assertion.meta.harness.run.usage, model: 'test/alpha' } } } } };

    const second: Assertion = { ...first, meta: { harness: { run: { ...first.meta.harness.run,
      session: { ...first.meta.harness.run.session, metadata: { ...first.meta.harness.run.session.metadata, trial: 2 } } } } } };

    const third: Assertion = { ...assertion, meta: { harness: { run: { ...assertion.meta.harness.run,
      usage: { ...assertion.meta.harness.run.usage, model: 'test/beta' } } } } };

    const rows = [first, second, third];
    const trialReviews = rows.map((row, index) => ({ id: `trial-${String(index + 1)}`, insights: extractInsights(row, evidence) }));

    const complete = { verdict: reply.verdict, trials: trialReviews.map((review) => ({ ...reply.trials[0], id: review.id,
      cause: { kind: 'agent:wrong-answer' }, explanation: 'The book lost an existing order.', fix: 'none in this repo' })) };

    const parsed = parseDiagnosis(JSON.stringify(complete), 'unchanged', trialReviews);
    const comment = renderDiagnosis(parsed, trialReviews, [...rows, { ...first, status: 'passed' }, { ...third, status: 'passed' }]);
    const causeRows = comment.split('\n').filter((line) => line.startsWith('| agent:wrong-answer |'));
    expect(causeRows.map((line) => line.split('|').slice(2, -1).map((cell) => Number(cell.trim())))).toEqual([[2, 1]]);
    const header = comment.split('\n').find((line) => line.startsWith('| Cause |')) ?? '';
    expect(header).toContain('test/alpha · product (2/3 failed)');
    expect(header).toContain('test/beta · product (1/2 failed)');
    expect(comment.split('\n').filter((line) => line.startsWith('- **')).map((line) => /trial (\d+)/.exec(line)?.[1])).toEqual(['1', '2', '1']);
  });
});
