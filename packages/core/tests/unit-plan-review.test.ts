import { describe, expect, test } from 'bun:test';
import { createTestActorsOver, toolExecute } from '@kinu.run/test-utils';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import {
  MAX_PLAN_ANNOTATIONS_BYTES,
  MAX_PLAN_CONTENT_BYTES,
  PLATFORM_CATALOG,
  PlanReviewActions,
  PlanReviewStore,
  PlanReviewSchema,
  applyPlanEdits,
  formatPlanWithLineNumbers,
  initPlanReviewTable,
  planAwaitingReply,
  planDecisionRefusal,
  workModeUnderReview,
  validatePlanEdits,
  buildBuiltinTools,
  type JsonValue,
  type PlanEdit,
  type ReviewAnnotation,
} from '../src/index';
import type { ProgrammaticTurn } from '../src/types/backend-host';
import { createTestRuntime, makeExecRaw, makeSql, conversationsFor } from './helpers';

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
      .toThrow(/1.5 MiB/);
  });

  test('content and annotation caps fit one platform row', () => {
    expect(MAX_PLAN_CONTENT_BYTES + MAX_PLAN_ANNOTATIONS_BYTES)
      .toBeLessThanOrEqual(PLATFORM_CATALOG['do.sqlite.row_bytes'].limit.value);
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

  const store = new PlanReviewStore(makeSql(db), createTestActorsOver(db).main, {
    newId: () => `plan-${++id}`,
    now: () => ++now,
  });

  return { db, store };
}

describe('durable plan review lifecycle', () => {
  test('malformed remote annotations are a failed parse, not an exception escaping safeParse', () => {
    const { db, store } = setup();

    try {
      const submitted = store.submit('default', [{ start: 1, content: '# Plan' }]);

      if (!submitted.ok) throw new Error(submitted.error);
      expect(v.safeParse(PlanReviewSchema, submitted.plan).success).toBe(true);
      expect(v.safeParse(PlanReviewSchema, { ...submitted.plan, annotations: [{ id: 'broken' }] }).success).toBe(false);
    } finally { db.close(); }
  });

  test('only unresolved review states hold an operator Build turn', () => {
    const held = (review: ReturnType<Parameters<typeof workModeUnderReview>[2]>) => workModeUnderReview('build', { kinuAuthor: 'operator' }, () => review);

    expect(held({ status: 'pending', handoffAccepted: false })).toBe('plan');
    expect(held({ status: 'changes_requested', handoffAccepted: false })).toBe('plan');
    expect(held({ status: 'approved', handoffAccepted: false })).toBe('plan');
    expect(held({ status: 'approved', handoffAccepted: true })).toBe('build');
    expect(held({ status: 'superseded', handoffAccepted: false })).toBe('build');
    expect(held({ status: 'dismissed', handoffAccepted: false })).toBe('build');
    expect(held(null)).toBe('build');
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

    const saved = store.saveAnnotations('plan-1', 1, { value: [annotation] });
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

    expect(store.saveAnnotations('plan-1', 1, { value: [{ ...base, source: 'external' }] })).toMatchObject({
      ok: false,
      error: expect.stringContaining('unsupported field'),
    });
    expect(store.saveAnnotations('plan-1', 1, { value: [{ ...base, endOffset: -1 }] })).toMatchObject({
      ok: false,
      error: expect.stringContaining('endOffset'),
    });
    expect(store.saveAnnotations('plan-1', 1, { value: [{ ...base, type: 'INSTRUCTION' }] })).toMatchObject({
      ok: false,
      error: expect.stringContaining('type'),
    });
    expect(store.getActive('default')?.annotations).toEqual([]);
  });

  test('refuses a plan larger than the stored row instead of throwing at the write', () => {
    const { store } = setup();
    const submitted = store.submit('default', [{ start: 1, content: 'x'.repeat(3 * 1024 * 1024) }]);
    expect(submitted.ok).toBe(false);

    if (submitted.ok) throw new Error('expected the oversized plan to be refused');
    expect(submitted.error).toMatch(/row size|maximum size/);
    expect(store.getActive('default')).toBeNull();
  });

  test('a resubmit before any review replaces the pending revision; an annotated one waits for a decision', () => {
    const { store } = setup();
    expect(store.submit('default', [{ start: 1, content: 'placeholder' }]).ok).toBe(true);
    expect(store.submit('default', [{ start: 1, content: '   ' }])).toMatchObject({ ok: false, error: expect.stringContaining('empty') });

    expect(store.submit('default', [{ start: 1, content: '# Tide Pool Study\n\n1. Map the zones' }])).toMatchObject({
      ok: true, plan: { id: 'plan-1', revision: 2, status: 'pending', content: '# Tide Pool Study\n\n1. Map the zones' },
    });
    expect(store.get('plan-1', 1)?.status).toBe('superseded');

    const annotation = {
      id: 'a1', blockId: 'paragraph-1', startOffset: 0, endOffset: 3, type: 'COMMENT' as const, text: 'why', originalText: 'Map',
      createdA: 1, author: 'Owner', startMeta: { parentTagName: 'P', parentIndex: 0, textOffset: 0 },
    };

    expect(store.saveAnnotations('plan-1', 2, { value: [annotation] }).ok).toBe(true);
    expect(store.submit('default', [{ start: 3, end: 3, content: 'Too soon' }])).toMatchObject({
      ok: false,
      error: expect.stringContaining('awaiting review'),
    });
  });

  test('rejects stale input', () => {
    const { store } = setup();
    const first = store.submit('default', [{ start: 1, content: '# Plan\n\nFirst' }]);
    expect(first.ok).toBe(true);
    expect(store.decide('plan-1', 2, 'request_changes', 'Clarify the last step')).toMatchObject({
      ok: false,
      error: expect.stringContaining('stale'),
    });
    expect(store.saveAnnotations('plan-1', 1, { value: {} })).toMatchObject({
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

  test('the owner dismisses an undecided plan: the lock lifts and the next plan starts fresh', () => {
    const { store } = setup();
    store.submit('default', [{ start: 1, content: '# One' }]);

    const dismissed = store.dismiss('plan-1', 1);
    expect(dismissed).toMatchObject({ ok: true, plan: { status: 'dismissed' } });
    expect(workModeUnderReview('build', { kinuAuthor: 'operator' }, () => store.getActive('default'))).toBe('build');
    expect(store.dismiss('plan-1', 1)).toMatchObject({ ok: true, plan: { status: 'dismissed' } });
    expect(store.decide('plan-1', 1, 'approve')).toMatchObject({ ok: false, error: expect.stringContaining('dismissed') });

    expect(store.submit('default', [{ start: 1, content: '# Two' }]))
      .toMatchObject({ ok: true, plan: { id: 'plan-2', revision: 1, status: 'pending' } });
  });

  test('a plan whose handoff already ran cannot be dismissed', () => {
    const { store } = setup();
    store.submit('default', [{ start: 1, content: '# One' }]);
    store.decide('plan-1', 1, 'approve');
    store.markHandoffAccepted('plan-1', 1);

    expect(store.dismiss('plan-1', 1)).toMatchObject({ ok: false, plan: { status: 'approved' } });
  });

  test('a sent-back plan is dismissable whether its revision turn is queued or already running', () => {
    for (const accepted of [false, true]) {
      const { store } = setup();
      store.submit('default', [{ start: 1, content: '# One' }]);
      store.decide('plan-1', 1, 'request_changes', 'Say what happens to the audit trail.');

      if (accepted) store.markHandoffAccepted('plan-1', 1);

      expect(store.dismiss('plan-1', 1)).toMatchObject({ ok: true, plan: { status: 'dismissed' } });
    }
  });
});

describe('the plan lock holds only its own thread', () => {
  const pending = { status: 'pending', handoffAccepted: false } as const;

  test('an operator message with no explicit mode is held in Plan', () => {
    expect(workModeUnderReview('build', { kinuAuthor: 'operator' }, () => pending)).toBe('plan');
  });

  test('an operator message sent in Auto runs as build', () => {
    expect(workModeUnderReview('build', { kinuAuthor: 'operator', kinuMode: 'build' }, () => pending)).toBe('build');
  });

  test('a harness turn (event drain, job, handoff) is outside the thread and keeps its mode', () => {
    expect(workModeUnderReview('build', { kinuAuthor: 'harness' }, () => pending)).toBe('build');
    expect(workModeUnderReview('build', { kinuAuthor: 'harness', kinuEvent: 'background_job', kinuMode: 'build' }, () => pending)).toBe('build');
  });

  test('a dismissed plan holds nothing', () => {
    expect(workModeUnderReview('build', { kinuAuthor: 'operator' }, () => ({ status: 'dismissed', handoffAccepted: false }))).toBe('build');
  });
});

describe('comments and their threads', () => {
  const PLAN = '# Tide pool survey\n\nMap the zones at low tide.\nCount the crabs in each zone.';

  const COMMENTS: readonly ReviewAnnotation[] = [
    { id: 'c1', type: 'COMMENT', blockId: 'paragraph-1', startOffset: 0, endOffset: 13, originalText: 'Map the zones', text: 'Which chart?', createdA: 1, author: 'Owner' },
    { id: 'd1', type: 'DELETION', blockId: 'paragraph-2', startOffset: 0, endOffset: 15, originalText: 'Count the crabs', createdA: 2, author: 'Owner' },
    { id: 'g1', type: 'GLOBAL_COMMENT', text: 'Split it into two mornings.', createdA: 3, author: 'Owner' },
  ];

  async function sentBack(store: PlanReviewStore, revision: number) {
    const handoffs: ProgrammaticTurn[] = [];

    const outcome = await new PlanReviewActions(store, { broadcast: () => {} }).decideAndHandOff(
      { id: 'plan-1', revision, decision: 'request_changes' },
      (turn) => {
        handoffs.push(turn);

        return Promise.resolve({ status: 'queued' as const });
      },
    );

    return { outcome, text: handoffs[0]?.text ?? '' };
  }

  test('a comment on the whole plan has no block, offsets or quote, and a request for changes sends it with the others', async () => {
    const { store } = setup();
    store.submit('default', [{ start: 1, content: PLAN }]);

    // As the viewer used to build it: a whole-plan comment on an empty block, which the review refused.
    expect(store.saveAnnotations('plan-1', 1, { value: [{ ...COMMENTS[2], blockId: '', startOffset: 0, endOffset: 0, originalText: '' }] }))
      .toMatchObject({ ok: false, error: expect.stringContaining('unsupported field') });
    expect(store.saveAnnotations('plan-1', 1, { value: [{ ...COMMENTS[0], blockId: '' }] })).toMatchObject({ ok: false });
    expect(store.saveAnnotations('plan-1', 1, { value: COMMENTS }).ok).toBe(true);

    const { outcome, text } = await sentBack(store, 1);

    expect(outcome).toMatchObject({ ok: true, queued: true, plan: { status: 'changes_requested' } });

    // Each comment reaches the agent with its id, which the reply tool names, and what it says or quotes.
    for (const said of ['c1', 'Which chart?', 'd1', 'Count the crabs', 'g1', 'Split it into two mornings.']) expect(text).toContain(said);
  });

  // 26244c765: the browser refused to approve over unsent comments while the store and the CLI approved and dropped them.
  test('a revision with comments is not approved over them, and is sent back on its comments alone', () => {
    const { store } = setup();
    store.submit('default', [{ start: 1, content: PLAN }]);
    expect(store.saveAnnotations('plan-1', 1, { value: COMMENTS }).ok).toBe(true);

    expect(store.decide('plan-1', 1, 'approve')).toMatchObject({ ok: false, error: expect.stringContaining('this revision has comments') });
    expect(store.decide('plan-1', 1, 'request_changes')).toMatchObject({ ok: true, plan: { status: 'changes_requested', feedback: expect.stringContaining('Which chart?') } });
  });

  test('a change request with nothing to send is refused in words, whether its feedback came absent or as null', () => {
    const { store } = setup();
    store.submit('default', [{ start: 1, content: PLAN }]);

    expect(store.decide('plan-1', 1, 'request_changes')).toMatchObject({ ok: false, error: 'a change request needs a comment or feedback' });
    // An RPC carries absent feedback as `null`, and the store asks the rule with what it was given.
    expect(planDecisionRefusal([], 'request_changes', null)).toBe('a change request needs a comment or feedback');
  });

  test('the agent answers in a thread; the next revision carries it read-only, and the owner\'s reply there is sent back', async () => {
    const { store } = setup();
    const actions = new PlanReviewActions(store, { broadcast: () => {} });
    const owner = { kinuAuthor: 'operator' };
    store.submit('default', [{ start: 1, content: PLAN }]);
    store.saveAnnotations('plan-1', 1, { value: COMMENTS });
    expect(actions.awaitingReply(owner)).toBe(false);
    await sentBack(store, 1);

    // The owner's turn and the revision's own feedback turn answer; a drain, or the feedback of another revision, does not.
    const feedback = { kinuEvent: 'plan_feedback', planId: 'plan-1', revision: 1 };
    expect(actions.awaitingReply(owner)).toBe(true);
    expect(actions.awaitingReply(feedback)).toBe(true);
    expect(actions.awaitingReply({ kinuEvent: 'subordinate_report' })).toBe(false);
    expect(actions.awaitingReply({ ...feedback, revision: 7 })).toBe(false);
    expect(actions.reply('c1', 'From a drain', { kinuEvent: 'subordinate_report' })).toMatchObject({ ok: false });

    expect(actions.reply('c1', '   ', feedback)).toMatchObject({ ok: false });
    expect(actions.reply('c1', 'The harbour office tide chart.', feedback)).toMatchObject({ ok: true });
    expect(store.reply('default', 'nope', 'Hello')).toMatchObject({ ok: false, error: expect.stringContaining('nope') });
    const answer = store.getActive('default')?.annotations.find((note) => note.type === 'REPLY');

    expect(answer).toMatchObject({ type: 'REPLY', inReplyTo: 'c1', author: 'agent', text: 'The harbour office tide chart.' });
    expect(store.reply('default', answer?.id ?? '', 'A reply to a reply')).toMatchObject({ ok: false });

    const revised = store.submit('default', [{ start: 3, end: 3, content: 'Map the zones from the harbour tide chart.' }]);

    expect(revised).toMatchObject({ ok: true, plan: { revision: 2, status: 'pending' } });
    expect(revised.plan?.annotations.map((note) => [note.id, note.revision])).toEqual([['c1', 1], ['d1', 1], ['g1', 1], [answer?.id, 1]]);
    expect(planAwaitingReply(revised.plan ?? null, owner)).toBe(false);
    expect(store.reply('default', 'c1', 'Too late')).toMatchObject({ ok: false });

    // The reviewer writes this revision's notes only: a carried note or an agent's reply is the review's own.
    expect(store.saveAnnotations('plan-1', 2, { value: [{ ...COMMENTS[0], revision: 1 }] })).toMatchObject({ ok: false });
    expect(store.saveAnnotations('plan-1', 2, { value: [{ id: 'r9', type: 'REPLY', inReplyTo: 'c1', text: 'x', author: 'agent', createdA: 9 }] }))
      .toMatchObject({ ok: false });

    const followUp = { id: 'o1', type: 'REPLY', inReplyTo: 'c1', text: 'Good; add the moon phase too.', author: 'owner', createdA: 9 } as const;

    expect(store.saveAnnotations('plan-1', 2, { value: [followUp] })).toMatchObject({ ok: true });
    expect(store.getActive('default')?.annotations).toHaveLength(5);

    const { text } = await sentBack(store, 2);

    // The owner's reply goes back under the comment it answers; threads with nothing new stay out.
    expect(text.indexOf('Good; add the moon phase too.')).toBeGreaterThan(text.indexOf('Which chart?'));
    expect(text).not.toContain('Split it into two mornings.');
  });

  test('a write is refused when the comments, as the next revision would carry them, outgrow the review', async () => {
    const { store } = setup();
    store.submit('default', [{ start: 1, content: PLAN }]);
    const note = (index: number): ReviewAnnotation => ({ id: `g${String(index)}`, type: 'GLOBAL_COMMENT', text: 'x'.repeat(9_000), createdA: index });
    const full = Array.from({ length: 28 }, (_, index) => note(index));

    expect(store.saveAnnotations('plan-1', 1, { value: full })).toMatchObject({ ok: true });
    await sentBack(store, 1);
    const revised = store.submit('default', [{ start: 1, content: PLAN }]);

    // Each write fits alone; with the carried 28 the list would pass the budget, so it is refused and the review still reads.
    expect(store.saveAnnotations('plan-1', 2, { value: [note(90), note(91)] })).toMatchObject({ ok: false, error: expect.stringContaining('maximum size') });
    expect(store.getActive('default')).toMatchObject({ id: revised.plan?.id, revision: 2 });
    expect(v.safeParse(PlanReviewSchema, store.getActive('default')).success).toBe(true);
  });

  test('a note whose time no date can hold is refused', () => {
    const { store } = setup();
    store.submit('default', [{ start: 1, content: PLAN }]);

    expect(store.saveAnnotations('plan-1', 1, { value: [{ ...COMMENTS[2], createdA: 9e15 }] })).toMatchObject({ ok: false });
  });
});

describe('submit_plan native tool', () => {
  test('exists only when a plan-mode submit dependency is wired', async () => {
    const { rt } = createTestRuntime();
    expect(buildBuiltinTools({ rt, conversations: conversationsFor(rt) }).submit_plan).toBeUndefined();

    const received: Array<readonly PlanEdit[]> = [];

    const tools = buildBuiltinTools({
      rt,
      conversations: conversationsFor(rt),
      submitPlan: {
        submit: (edits) => {
          received.push([...edits]);

          return {
            ok: true as const,
            plan: {
              id: 'plan-1', sessionId: 'default', revision: 1, content: '# Plan',
              status: 'pending' as const, annotations: [], feedback: null,
              handoffAccepted: false,
              createdAt: 1, updatedAt: 1,
            },
          };
        },
      },
    });

    expect(tools.submit_plan).toBeDefined();
    const submitPlan = toolExecute<{ edits: PlanEdit[] }, JsonValue>(tools.submit_plan);

    const result = await submitPlan({
      edits: [{ start: 1, content: '# Plan' }],
    });

    expect(received).toEqual([[{ start: 1, content: '# Plan' }]]);
    expect(result).toMatchObject({ planId: 'plan-1', revision: 1, status: 'pending' });
    expect(JSON.stringify(result)).toContain('awaiting review');

    // Edits sent as a JSON string, as a model whose tool calls serialize arrays to text sent them on staging.
    const malformed = toolExecute<{ edits: string }, JsonValue>(tools.submit_plan);
    await expect(malformed({ edits: '[{"content": "# Tide Pool Study"}]' })).rejects.toThrow('sent as an array and not as text');
    expect(received).toHaveLength(1);
  });

  test('reply_to_comment exists only while its dependency is wired, and answers with the reply it wrote', async () => {
    const { rt } = createTestRuntime();
    const { store } = setup();
    store.submit('default', [{ start: 1, content: '# Plan\n\nDo it' }]);
    store.saveAnnotations('plan-1', 1, { value: [{ id: 'g1', type: 'GLOBAL_COMMENT', text: 'Why now?', createdA: 1 }] });
    store.decide('plan-1', 1, 'request_changes');
    expect(buildBuiltinTools({ rt, conversations: conversationsFor(rt) }).reply_to_comment).toBeUndefined();

    const tools = buildBuiltinTools({
      rt, conversations: conversationsFor(rt), replyToComment: { reply: (comment, text) => store.reply('default', comment, text) },
    });

    const reply = toolExecute<{ comment: string; text: string }, JsonValue>(tools.reply_to_comment);

    expect(await reply({ comment: 'g1', text: 'The migration window opens Monday.' })).toMatchObject({ planId: 'plan-1', revision: 1, comment: 'g1' });
    await expect(reply({ comment: 'g2', text: 'Hello' })).rejects.toThrow('no comment g2');
  });
});
