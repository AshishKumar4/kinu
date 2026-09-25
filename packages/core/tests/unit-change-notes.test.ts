import { describe, expect, test } from 'bun:test';
import { admitReviewAnnotations, MAX_PLAN_ANNOTATIONS_BYTES } from '../src/plans/review';
import { anchoredText, comparePaths, inReadingOrder } from '../src/read-models/change-view';
import {
  changeNotesCard, initChangeNotesTable, readChangeNotes, saveChangeNotes, sendChangeNotes, type ChangeNotesMessage, type NotedChanges,
} from '../src/read-models/change-notes';
import type { DiffAnchor, ReviewAnnotation } from '../src/types/plans';
import { diffLines, fileDiff, parseGitDiff } from '../src/vfs/diff';
import { createTestRuntime } from './helpers';

const BASELINE = 'gen-4f1c9a';

function note(id: string, type: ReviewAnnotation['type'], fields: Pick<ReviewAnnotation, 'text' | 'anchor'> & { quote?: string }): ReviewAnnotation {
  const { quote = '', ...placed } = fields;

  return {
    id, type, blockId: placed.anchor === undefined ? 'changes' : placed.anchor.path, startOffset: 0, endOffset: 0,
    originalText: quote, createdA: 1, ...placed,
  };
}

const lines = (path: string, lineStart: number, lineEnd: number): DiffAnchor => ({ scope: 'lines', path, side: 'new', lineStart, lineEnd, baseline: BASELINE });

const APPLY = 'packages/checkout/src/apply-coupon.ts';

const NOTES: readonly ReviewAnnotation[] = [
  note('all', 'GLOBAL_COMMENT', { text: 'Run the checkout tests again.' }),
  note('test', 'DELETION', { quote: 'test("label")', anchor: lines('packages/checkout/tests/coupon-kind.test.ts', 27, 29) }),
  note('legacy', 'COMMENT', { text: 'Keep this until the old carts are migrated.', anchor: { scope: 'file', path: 'packages/checkout/src/legacy-discount.ts', baseline: BASELINE } }),
  note('clamp', 'COMMENT', {
    text: 'Clamp it, but log it too.', quote: 'Math.min(coupon.value, ```rule```)',
    anchor: { scope: 'text', path: APPLY, side: 'new', lineStart: 27, lineEnd: 27, charStart: 4, charEnd: 38, baseline: BASELINE },
  }),
];

const WORKSPACE: NotedChanges = { source: 'workspace', label: 'Workspace', mode: 'vfs-baseline', trackedSince: Date.UTC(2026, 8, 24, 14, 14) };

/** The message a source's notes become when sent, as the chat's admission takes it. */
async function sent(notes: readonly ReviewAnnotation[]): Promise<ChangeNotesMessage> {
  const { rt } = createTestRuntime();
  initChangeNotesTable(rt.storage.execRaw);
  saveChangeNotes(rt, WORKSPACE.source, { value: notes });
  const messages: ChangeNotesMessage[] = [];

  // As the chat's admission does: `consume` runs in the transaction that reserves the message.
  const result = await sendChangeNotes(rt, { value: WORKSPACE }, (message, consume) => {
    consume();
    messages.push(message);

    return Promise.resolve();
  });

  if (!result.ok || messages[0] === undefined) throw new Error('the notes were not sent');

  return messages[0];
}

describe('notes on a change-set', () => {
  test('a note carries its place in the diff through the one admission plan review uses, and a bad place is refused', () => {
    const [clamp] = NOTES.filter((each) => each.id === 'clamp');

    expect(admitReviewAnnotations({ value: [clamp] })).toEqual({ ok: true, annotations: [clamp] });

    for (const anchor of [
      { ...lines(APPLY, 30, 27) },
      { scope: 'text', path: APPLY, side: 'new', lineStart: 27, lineEnd: 27, charStart: 9, charEnd: 9, baseline: BASELINE },
      { ...lines(APPLY, 27, 27), side: 'both' },
      { ...lines(APPLY, 27, 27), note: 'unasked' },
    ]) {
      expect(admitReviewAnnotations({ value: [{ ...clamp, anchor }] }).ok).toBe(false);
    }

    // The same admission keeps a set within plan review's limit: a long note is kept, an oversized set is not.
    expect(admitReviewAnnotations({ value: [{ ...clamp, text: 'x'.repeat(4096) }] }).ok).toBe(true);
    expect(admitReviewAnnotations({ value: [{ ...clamp, text: 'x'.repeat(MAX_PLAN_ANNOTATIONS_BYTES) }] }).ok).toBe(false);
  });

  test('notes are kept per source until replaced, with one note on all the changes at most', () => {
    const { rt } = createTestRuntime();
    initChangeNotesTable(rt.storage.execRaw);

    expect(saveChangeNotes(rt, 'workspace', { value: NOTES }).ok).toBe(true);
    expect(saveChangeNotes(rt, 'laptop', { value: NOTES.slice(0, 1) }).ok).toBe(true);
    expect(readChangeNotes(rt, 'workspace')).toEqual([...NOTES]);
    expect(readChangeNotes(rt, 'laptop').map((each) => each.id)).toEqual(['all']);

    // A second note on everything, a note on everything with a place, or a place-less note on a line: each refused,
    // and the kept notes stand.
    for (const refused of [
      [...NOTES, note('again', 'GLOBAL_COMMENT', { text: 'twice' })],
      [note('placed', 'GLOBAL_COMMENT', { text: 'x', anchor: lines(APPLY, 1, 1) })],
      [note('loose', 'COMMENT', { text: 'where?' })],
    ]) {
      expect(saveChangeNotes(rt, 'workspace', { value: refused }).ok).toBe(false);
    }

    expect(readChangeNotes(rt, 'workspace')).toEqual([...NOTES]);
    expect(saveChangeNotes(rt, 'workspace', { value: [] }).ok).toBe(true);
    expect(readChangeNotes(rt, 'workspace')).toEqual([]);
    expect(readChangeNotes(rt, 'laptop').map((each) => each.id)).toEqual(['all']);
  });

  test('the text reads the files in the tree\'s order, each note under its lines with its quote, everything last', async () => {
    const { text } = await sent(NOTES);
    const headings = text.split('\n').filter((line) => line.startsWith('## ')).map((line) => line.slice(3));

    expect(headings).toEqual([APPLY, 'packages/checkout/src/legacy-discount.ts', 'packages/checkout/tests/coupon-kind.test.ts', 'All the changes']);
    expect(text).toContain('since 2026-09-24 14:14 UTC (snapshot gen-4f)');
    // The quote holds a fence of three, so its own fence is four.
    expect(text).toContain('### Line 27 (new)\n````\nMath.min(coupon.value, ```rule```)\n````\nClamp it, but log it too.');
    expect(text).toContain('### Whole file\nKeep this until the old carts are migrated.');
    expect(text).toContain('### Lines 27-29 (new)\n```\ntest("label")\n```\nRemove this.');
    expect(text.endsWith('## All the changes\n\nRun the checkout tests again.')).toBe(true);
  });

  test('the sent message is one card: its metadata reads back as the notes, in the tree\'s order', async () => {
    const message = await sent(NOTES);
    const card = changeNotesCard({ metadata: message.metadata });

    expect(card?.notes.map((each) => each.id)).toEqual(['clamp', 'legacy', 'test', 'all']);
    expect(card?.notes[0]).toEqual({ id: 'clamp', type: 'COMMENT', text: 'Clamp it, but log it too.', anchor: NOTES[3]?.anchor });
    expect(changeNotesCard({ metadata: { kinuEvent: 'plan_feedback' } })).toBeNull();
    // Each send is a message of its own, never a retry of another's.
    expect((await sent(NOTES)).id).not.toBe(message.id);
  });

  test('the notes move in admission\'s transaction: one saved before admission answers is kept for the next send', async () => {
    const { rt } = createTestRuntime();
    initChangeNotesTable(rt.storage.execRaw);
    const [first, later] = [NOTES[3], NOTES[2]];

    if (first === undefined || later === undefined) throw new Error('the fixture lost its notes');
    saveChangeNotes(rt, WORKSPACE.source, { value: [first] });
    const answer = Promise.withResolvers<void>();
    const sentIds: string[][] = [];

    const admit = (message: ChangeNotesMessage, consume: () => void, answered: Promise<void>): Promise<void> => {
      consume();
      sentIds.push(changeNotesCard({ metadata: message.metadata })?.notes.map((each) => each.id) ?? []);

      return answered;
    };

    const sending = sendChangeNotes(rt, { value: WORKSPACE }, (message, consume) => admit(message, consume, answer.promise));

    // The operator writes another note before admission has answered.
    expect(saveChangeNotes(rt, WORKSPACE.source, { value: [later] }).ok).toBe(true);
    answer.resolve();

    expect(await sending).toEqual({ ok: true, notes: [] });
    expect(readChangeNotes(rt, WORKSPACE.source)).toEqual([later]);
    // The next send carries the later note alone: each note is sent once.
    expect(await sendChangeNotes(rt, { value: WORKSPACE }, (message, consume) => admit(message, consume, Promise.resolve()))).toMatchObject({ ok: true });
    expect(sentIds).toEqual([[first.id], [later.id]]);
  });

  test('a refused admission moves nothing, and consuming notes that changed refuses', async () => {
    const { rt } = createTestRuntime();
    initChangeNotesTable(rt.storage.execRaw);
    const [clamp, deletion] = [NOTES[3], NOTES[1]];

    if (clamp === undefined || deletion === undefined) throw new Error('the fixture lost its notes');
    saveChangeNotes(rt, WORKSPACE.source, { value: [clamp] });

    await expect(sendChangeNotes(rt, { value: WORKSPACE }, () => Promise.reject(new Error('the workspace is closing'))))
      .rejects.toThrow('the workspace is closing');
    expect(readChangeNotes(rt, WORKSPACE.source).map((each) => each.id)).toEqual(['clamp']);

    // Notes saved between the read and the consume are not the ones the message carries: nothing is deleted.
    const changed = sendChangeNotes(rt, { value: WORKSPACE }, (_message, consume) => {
      saveChangeNotes(rt, WORKSPACE.source, { value: [clamp, deletion] });
      consume();

      return Promise.resolve();
    });

    await expect(changed).rejects.toThrow('the notes changed while they were being sent');
    expect(readChangeNotes(rt, WORKSPACE.source).map((each) => each.id)).toEqual(['clamp', 'test']);
  });

  test('notes written on different baselines name each file\'s own', async () => {
    const [clamp] = NOTES.filter((each) => each.id === 'clamp');
    const rule = note('rule', 'COMMENT', { text: 'Name this.', anchor: { ...lines('packages/checkout/src/rules.ts', 4, 4), baseline: 'gen-9b2e77' } });
    const { text } = await sent([...clamp === undefined ? [] : [clamp], rule]);
    const headings = text.split('\n').filter((line) => line.startsWith('## ')).map((line) => line.slice(3));

    expect(headings).toEqual([`${APPLY} (snapshot gen-4f)`, 'packages/checkout/src/rules.ts (snapshot gen-9b)']);
    expect(text).not.toContain('(snapshot gen-4f).');
    expect(text).toContain('more than one snapshot; each file names its own.');
  });

  test('a note learns its code moved: its quote reads the same at its lines only until they change', () => {
    const before = 'import x\nconst rule = rules[kind];\nreturn rule;';
    const now = 'import x\nconst rule = rules[kindOf(coupon)];\nreturn rule;';
    const file = fileDiff('src/apply.ts', 'changed', diffLines(before, now));
    const words: DiffAnchor = { scope: 'text', path: 'src/apply.ts', side: 'new', lineStart: 2, lineEnd: 2, charStart: 19, charEnd: 33, baseline: BASELINE };
    const quote = anchoredText(file, words);

    expect(quote).toBe('kindOf(coupon)');
    expect(anchoredText(file, { ...lines('src/apply.ts', 2, 3) })).toBe('const rule = rules[kindOf(coupon)];\nreturn rule;');
    expect(anchoredText(file, { ...words, side: 'old', charStart: 19, charEnd: 23 })).toBe('kind');

    const edited = fileDiff('src/apply.ts', 'changed', diffLines(before, 'import x\nconst rule = lookup(coupon);\nreturn rule;'));

    expect(anchoredText(edited, words)).not.toBe(quote);

    // A git diff holds only its hunks, so a line outside them has no text to compare.
    const [git] = parseGitDiff(['diff --git a/src/apply.ts b/src/apply.ts', '--- a/src/apply.ts', '+++ b/src/apply.ts',
      '@@ -40,1 +40,1 @@', '-old', '+new'].join('\n'));

    expect(git === undefined ? 'missing' : anchoredText(git, words)).toBeNull();
  });

  test('notes and the tree agree on the order of paths', () => {
    const paths = ['README.md', 'packages/checkout/src/rules.ts', 'packages/checkout/tests/kind.test.ts', 'packages/checkout/src/apply.ts',
      'packages/checkout/migrations/0042.sql', 'docs/runbook.md', 'a.ts'];

    const files = paths.map((path) => fileDiff(path, 'changed', diffLines('a', 'b')));

    expect([...paths].sort(comparePaths)).toEqual(inReadingOrder(files).map((file) => file.path));
  });
});
