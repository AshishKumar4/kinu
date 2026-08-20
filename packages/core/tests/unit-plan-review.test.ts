import { describe, expect, test } from 'bun:test';
import { toolExecute } from '@kinu/test-utils';
import { Database } from 'bun:sqlite';
import {
  MAX_PLAN_CONTENT_BYTES,
  PlanReviewStore,
  applyPlanEdits,
  formatPlanWithLineNumbers,
  initPlanReviewTable,
  planReviewAwaitingDecision,
  validatePlanEdits,
  buildBuiltinTools,
  type JsonValue,
  type PlanEdit,
} from '../src/index';
import { createTestRuntime, makeExecRaw, makeSql } from './helpers';

describe('plan edit contract', () => {
  test('writes the initial full plan and applies later edits against pre-edit line numbers', () => {
    const initial = applyPlanEdits([], [{ start: 1, content: '# Plan\n\nA\nB' }]);
    expect(initial).toEqual(['# Plan', '', 'A', 'B']);

    expect(applyPlanEdits(initial, [
      { start: 2, end: 2, content: 'Overview' },
      { start: 4, end: 4, content: 'B revised\nC' },
    ])).toEqual(['# Plan', 'Overview', 'A', 'B revised', 'C']);
  });

  test('supports deletion and replacement through end-of-plan', () => {
    expect(applyPlanEdits(['one', 'two', 'three'], [
      { start: 2, end: 2, content: '' },
    ])).toEqual(['one', 'three']);
    expect(applyPlanEdits(['one', 'two', 'three'], [
      { start: 2, content: 'tail' },
    ])).toEqual(['one', 'tail']);
  });

  test('rejects invalid, overlapping, empty, and oversized submissions', () => {
    expect(validatePlanEdits(['one', 'two'], [{ start: 0, content: 'x' }])).toMatch(/positive integer/);
    expect(validatePlanEdits(['one'], [{ start: 3, content: 'x' }])).toMatch(/file length/);
    expect(validatePlanEdits(['one', 'two'], [
      { start: 1, end: 2, content: 'x' },
      { start: 2, end: 2, content: 'y' },
    ])).toMatch(/overlap/);
    expect(() => applyPlanEdits([], [{ start: 1, content: '   ' }])).toThrow(/empty/);
    expect(() => applyPlanEdits([], [{ start: 1, content: 'x'.repeat(MAX_PLAN_CONTENT_BYTES + 1) }]))
      .toThrow(/5 MiB/);
  });

  test('formats stable one-indexed line references for revision feedback', () => {
    expect(formatPlanWithLineNumbers('one\ntwo\nthree')).toBe('1| one\n2| two\n3| three');
  });
});

function setup() {
  const db = new Database(':memory:');
  initPlanReviewTable(makeExecRaw(db));
  let id = 0;
  let now = 100;
  const store = new PlanReviewStore(makeSql(db), {
    newId: () => `plan-${++id}`,
    now: () => ++now,
  });
  return { db, store };
}

describe('durable plan review lifecycle', () => {
  test('only unresolved review states block Build turns', () => {
    expect(planReviewAwaitingDecision({ status: 'pending', handoffAccepted: false })).toBe(true);
    expect(planReviewAwaitingDecision({ status: 'changes_requested', handoffAccepted: false })).toBe(true);
    expect(planReviewAwaitingDecision({ status: 'approved', handoffAccepted: false })).toBe(true);
    expect(planReviewAwaitingDecision({ status: 'approved', handoffAccepted: true })).toBe(false);
    expect(planReviewAwaitingDecision({ status: 'superseded', handoffAccepted: false })).toBe(false);
    expect(planReviewAwaitingDecision(null)).toBe(false);
  });

  test('persists a pending first revision with durable annotations', () => {
    const { store } = setup();
    const submitted = store.submit('default', [{ start: 1, content: '# Plan\n\nDo it' }]);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) throw new Error(submitted.error);
    expect(submitted.plan).toMatchObject({
      id: 'plan-1', sessionId: 'default', revision: 1,
      content: '# Plan\n\nDo it', status: 'pending', annotations: [], feedback: null,
    });

    const annotation = {
      id: 'a1', blockId: 'paragraph-1', startOffset: 0, endOffset: 7,
      type: 'COMMENT' as const, text: 'clarify', originalText: 'Do it',
      createdA: 1, author: 'Owner',
      startMeta: { parentTagName: 'P', parentIndex: 0, textOffset: 0 },
      mathTargets: [{ blockId: 'math-1', tex: 'x^2', displayMode: false }],
    };
    const saved = store.saveAnnotations('plan-1', 1, [annotation]);
    expect(saved.ok).toBe(true);
    expect(store.getActive('default')?.annotations).toEqual([annotation]);
  });

  test('admits only the plan-review annotation shape at the durable boundary', () => {
    const { store } = setup();
    store.submit('default', [{ start: 1, content: '# Plan\n\nDo it' }]);
    const base = {
      id: 'a1', blockId: 'paragraph-1', startOffset: 0, endOffset: 4,
      type: 'COMMENT', originalText: 'Plan', createdA: 1,
    };

    expect(store.saveAnnotations('plan-1', 1, [{ ...base, source: 'external' }])).toMatchObject({
      ok: false,
      error: expect.stringContaining('unsupported field'),
    });
    expect(store.saveAnnotations('plan-1', 1, [{ ...base, endOffset: -1 }])).toMatchObject({
      ok: false,
      error: expect.stringContaining('offsets'),
    });
    expect(store.saveAnnotations('plan-1', 1, [{ ...base, type: 'INSTRUCTION' }])).toMatchObject({
      ok: false,
      error: expect.stringContaining('type'),
    });
    expect(store.getActive('default')?.annotations).toEqual([]);
  });

  test('requires a decision before another revision and rejects stale input', () => {
    const { store } = setup();
    const first = store.submit('default', [{ start: 1, content: '# Plan\n\nFirst' }]);
    expect(first.ok).toBe(true);
    expect(store.submit('default', [{ start: 3, end: 3, content: 'Too soon' }])).toMatchObject({
      ok: false,
      error: expect.stringContaining('awaiting review'),
    });
    expect(store.decide('plan-1', 2, 'request_changes', 'Clarify the last step')).toMatchObject({
      ok: false,
      error: expect.stringContaining('stale'),
    });
    expect(store.saveAnnotations('plan-1', 1, {})).toMatchObject({
      ok: false,
      error: 'annotations must be an array',
    });
  });

  test('request changes persists feedback, then a targeted edit creates a new pending revision', () => {
    const { store } = setup();
    store.submit('default', [{ start: 1, content: '# Plan\n\nFirst\nSecond' }]);

    const decision = store.decide('plan-1', 1, 'request_changes', 'Replace the final step');
    expect(decision).toMatchObject({
      ok: true,
      plan: { status: 'changes_requested', feedback: 'Replace the final step' },
    });

    const revised = store.submit('default', [{ start: 4, end: 4, content: 'Second, verified' }]);
    expect(revised).toMatchObject({
      ok: true,
      plan: {
        id: 'plan-1', revision: 2, status: 'pending',
        content: '# Plan\n\nFirst\nSecond, verified', annotations: [], feedback: null,
      },
    });
    expect(store.get('plan-1', 1)?.status).toBe('superseded');
  });

  test('approval is idempotent and a future plan starts a new review', () => {
    const { store } = setup();
    store.submit('default', [{ start: 1, content: '# One' }]);
    const approved = store.decide('plan-1', 1, 'approve', 'Proceed exactly as written');
    expect(approved).toMatchObject({ ok: true, plan: { status: 'approved', handoffAccepted: false } });
    expect(store.decide('plan-1', 1, 'approve')).toMatchObject({
      ok: true,
      plan: { status: 'approved', handoffAccepted: false },
    });
    expect(store.markHandoffAccepted('plan-1', 1)).toMatchObject({
      ok: true,
      plan: { status: 'approved', handoffAccepted: true },
    });
    expect(store.markHandoffAccepted('plan-1', 1)).toMatchObject({
      ok: true,
      plan: { handoffAccepted: true },
    });

    const next = store.submit('default', [{ start: 1, content: '# Two' }]);
    expect(next).toMatchObject({ ok: true, plan: { id: 'plan-2', revision: 1, content: '# Two' } });
  });
});

describe('submit_plan native tool', () => {
  test('exists only when a plan-mode submit dependency is wired', async () => {
    const { rt } = createTestRuntime();
    expect(buildBuiltinTools({ rt }).submit_plan).toBeUndefined();

    const received: Array<readonly PlanEdit[]> = [];
    const tools = buildBuiltinTools({
      rt,
      submitPlan: {
        submit: (edits) => {
          received.push([...edits]);
          return {
            ok: true as const,
            plan: {
              id: 'plan-1', sessionId: 'default', revision: 1, content: '# Plan',
              status: 'pending' as const, annotations: [], feedback: null,
              handoffAccepted: false,
              createdAt: 1, updatedAt: 1, decidedAt: null,
            },
          };
        },
      },
    });
    expect(tools.submit_plan).toBeDefined();
    const submitPlan = toolExecute<{ edits: PlanEdit[] }, JsonValue>(tools.submit_plan!);
    const result = await submitPlan({
      edits: [{ start: 1, content: '# Plan' }],
    });
    expect(received).toEqual([[{ start: 1, content: '# Plan' }]]);
    expect(result).toMatchObject({ ok: true, planId: 'plan-1', revision: 1 });
    expect(JSON.stringify(result)).toContain('awaiting review');
  });
});
