/**
 * A run of a turn's tool calls, and the thinking between them, is one group in the chat (the owner, 2026-10-17): what
 * the turn did folds behind one line, and what the owner reads or answers (the answer, a preview, a question) stands
 * outside it.
 */
import { describe, expect, test } from 'bun:test';
import type { UIMessage } from 'ai';
import { groupMessageParts, toolRunSummary, type PartBlock } from '../src/read-models/tool-call-grouping';

type Part = UIMessage['parts'][number];

const read = (id: string, path: string): Part => ({ type: 'tool-file', toolCallId: id, state: 'output-available', input: { op: 'read', path }, output: '…' });

const search = (id: string): Part => ({ type: 'tool-web', toolCallId: id, state: 'output-available', input: { op: 'search', query: 'coupon kind null' }, output: '…' });

const fetchPage = (id: string, state: 'output-available' | 'input-available' = 'output-available'): Part => (state === 'input-available'
  ? { type: 'tool-web', toolCallId: id, state, input: { op: 'fetch', url: 'https://example.com' } }
  : { type: 'tool-web', toolCallId: id, state, input: { op: 'fetch', url: 'https://example.com' }, output: '…' });

const failed = (id: string): Part => ({ type: 'tool-run', toolCallId: id, state: 'output-error', input: { runtime: 'workspace', command: 'bun test' }, errorText: 'exit 1' });

const thought = (text: string): Part => ({ type: 'reasoning', state: 'done', text });

const said = (text: string): Part => ({ type: 'text', state: 'done', text });

/** Each block as its kind and the ids or words it holds. */
function laidOut(blocks: readonly PartBlock[]): unknown[] {
  return blocks.map((block) => {
    if (block.kind === 'run') return { run: block.steps.map((step) => (step.kind === 'tool' ? step.part.toolCallId : step.parts.map((part) => part.text).join('+'))) };

    if (block.kind === 'reasoning') return { reasoning: block.parts.map((part) => part.text).join('+') };

    return { part: 'toolCallId' in block.part ? block.part.toolCallId : block.part.type };
  });
}

describe('a run of tool calls', () => {
  test('two calls in a row, and the thinking around and between them, are one group; the answer stands after it', () => {
    const blocks = groupMessageParts([
      thought('Start with the handler'), { type: 'step-start' }, read('c1', 'a.ts'), thought('Now the migration'), read('c2', 'b.sql'),
      { type: 'step-start' }, said('The guard is missing.'),
    ]);

    expect(laidOut(blocks)).toEqual([{ run: ['Start with the handler', 'c1', 'Now the migration', 'c2'] }, { part: 'text' }]);
  });

  test('one call alone is its own row, and the thinking beside it its own block', () => {
    expect(laidOut(groupMessageParts([thought('Look first'), read('c1', 'a.ts'), said('Done.')])))
      .toEqual([{ reasoning: 'Look first' }, { part: 'c1' }, { part: 'text' }]);
  });

  // A call that started a preview splits it too; only a page that knows its preview host can tell one, so the browser
  // suite proves that one (chat-and-files-ux, the tool run's preview).
  test('a question for the owner, and the words between runs, each split it', () => {
    const blocks = groupMessageParts([
      read('c1', 'a.ts'), read('c2', 'b.ts'),
      { type: 'tool-ask_owner', toolCallId: 'ask', state: 'input-available', input: { questions: [] } },
      read('c3', 'c.ts'), read('c4', 'd.ts'), read('c5', 'e.ts'), said('Halfway.'), read('c6', 'f.ts'),
    ]);

    expect(laidOut(blocks)).toEqual([{ run: ['c1', 'c2'] }, { part: 'ask' }, { run: ['c3', 'c4', 'c5'] }, { part: 'text' }, { part: 'c6' }]);
  });

  test('blank words and thoughts draw nothing, so they do not split a run', () => {
    expect(laidOut(groupMessageParts([read('c1', 'a.ts'), said('  '), thought(''), read('c2', 'b.ts')]))).toEqual([{ run: ['c1', 'c2'] }]);
  });
});

describe("a run's summary", () => {
  const stepsOf = (parts: Part[]) => {
    const [block] = groupMessageParts(parts);

    if (block?.kind !== 'run') throw new Error('no run');

    return block.steps;
  };

  test('says what the run is doing, the kind it did last, last, and counts its calls and failures', () => {
    expect(toolRunSummary(stepsOf([search('s1'), fetchPage('p1'), fetchPage('p2'), fetchPage('p3', 'input-available')])))
      .toEqual({ calls: 4, failed: 0, doing: 'Searching the web · reading 3 pages' });
    expect(toolRunSummary(stepsOf([read('c1', 'a.ts'), failed('r1'), read('c2', 'b.ts')])))
      .toEqual({ calls: 3, failed: 1, doing: 'Running a command · reading 2 files' });
  });

  test('a long run names only its two newest kinds of work', () => {
    const many = [search('s1'), ...Array.from({ length: 18 }, (_, index) => read(`c${String(index)}`, `m${String(index)}.ts`)), fetchPage('p1')];

    expect(toolRunSummary(stepsOf(many))).toEqual({ calls: 20, failed: 0, doing: 'Reading 18 files · reading a page' });
  });
});
