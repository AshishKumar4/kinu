/**
 * A run of a turn's tool calls is one phase in the chat (the owner, 2026-10-17, 2026-10-19): what it did folds behind a
 * line of a few words, thinking streams outside it as it always has, and what the owner reads or answers (the answer,
 * a preview, a question) stands outside it. A long turn's earlier phases roll up under one more line.
 */
import { describe, expect, test } from 'bun:test';
import type { UIMessage } from 'ai';
import { groupMessageParts, rollUpTurn, toolRunSummary, type PartBlock, type TurnBlock } from '../src/read-models/tool-call-grouping';
import { PHASE_TITLES_METADATA_KEY, TURN_TITLE_METADATA_KEY, phaseTitle, writtenTitles } from '../src/read-models/tool-phase-title';

type Part = UIMessage['parts'][number];

const read = (id: string, path: string): Part => ({ type: 'tool-file', toolCallId: id, state: 'output-available', input: { op: 'read', path }, output: '…' });

const edit = (id: string, path: string): Part => ({ type: 'tool-file', toolCallId: id, state: 'output-available', input: { op: 'edit', path, edits: [{}] }, output: 'ok' });

const shell = (id: string, command: string, output: string): Part => ({ type: 'tool-shell', toolCallId: id, state: 'output-available', input: { runtime: 'workspace', command }, output });

const running = (id: string, path: string): Part => ({ type: 'tool-file', toolCallId: id, state: 'input-available', input: { op: 'read', path } });

const search = (id: string): Part => ({ type: 'tool-web', toolCallId: id, state: 'output-available', input: { op: 'search', query: 'd1 binding renamed' }, output: '…' });

const failed = (id: string): Part => ({ type: 'tool-shell', toolCallId: id, state: 'output-error', input: { runtime: 'workspace', command: 'bun test' }, errorText: '2 failed' });

const thought = (text: string): Part => ({ type: 'reasoning', state: 'done', text });

const said = (text: string): Part => ({ type: 'text', state: 'done', text });

const ask: Part = { type: 'tool-ask_owner', toolCallId: 'ask', state: 'input-available', input: { questions: [] } };

/** Each block as its kind and the ids or words it holds. */
function laidOut(blocks: readonly TurnBlock[]): unknown[] {
  return blocks.map((block) => {
    if (block.kind === 'turn') return { turn: laidOut(block.blocks) };

    if (block.kind === 'run') return { run: block.steps.map((step) => (step.kind === 'tool' ? step.part.toolCallId : step.parts.map((part) => part.text).join('+'))) };

    if (block.kind === 'reasoning') return { reasoning: block.parts.map((part) => part.text).join('+') };

    return { part: 'toolCallId' in block.part ? block.part.toolCallId : block.part.type };
  });
}

describe('a phase of tool calls', () => {
  test('two calls in a row are one phase with the thinking between them; the thinking before and after stands outside', () => {
    const blocks = groupMessageParts([
      thought('Start with the handler'), { type: 'step-start' }, read('c1', 'a.ts'), thought('Now the migration'), read('c2', 'b.sql'),
      thought('So the guard is gone'), { type: 'step-start' }, said('The guard is missing.'),
    ]);

    expect(laidOut(blocks)).toEqual([
      { reasoning: 'Start with the handler' }, { run: ['c1', 'Now the migration', 'c2'] }, { reasoning: 'So the guard is gone' }, { part: 'text' },
    ]);
  });

  test('a thought streaming after the calls stands outside the phase until the next call takes it in', () => {
    expect(laidOut(groupMessageParts([read('c1', 'a.ts'), read('c2', 'b.ts'), thought('Next, the tests')])))
      .toEqual([{ run: ['c1', 'c2'] }, { reasoning: 'Next, the tests' }]);
    expect(laidOut(groupMessageParts([read('c1', 'a.ts'), read('c2', 'b.ts'), thought('Next, the tests'), running('c3', 'c.ts')])))
      .toEqual([{ run: ['c1', 'c2', 'Next, the tests', 'c3'] }]);
  });

  test('one call alone is its own row, and the thinking beside it its own block', () => {
    expect(laidOut(groupMessageParts([thought('Look first'), read('c1', 'a.ts'), said('Done.')])))
      .toEqual([{ reasoning: 'Look first' }, { part: 'c1' }, { part: 'text' }]);
  });

  // A call that started a preview ends one too; only a page that knows its preview host can tell one, so the browser
  // suite proves that one (chat-and-files-ux, the tool run's preview).
  test('a question for the owner, and the words between phases, each end one', () => {
    const blocks = groupMessageParts([read('c1', 'a.ts'), read('c2', 'b.ts'), ask, read('c3', 'c.ts'), read('c4', 'd.ts'), read('c5', 'e.ts'), said('Halfway.'), read('c6', 'f.ts')]);

    expect(laidOut(blocks)).toEqual([{ run: ['c1', 'c2'] }, { part: 'ask' }, { run: ['c3', 'c4', 'c5'] }, { part: 'text' }, { part: 'c6' }]);
  });

  test('blank words and thoughts draw nothing, so they do not end a phase', () => {
    expect(laidOut(groupMessageParts([read('c1', 'a.ts'), said('  '), thought(''), read('c2', 'b.ts')]))).toEqual([{ run: ['c1', 'c2'] }]);
  });
});

describe('a long turn', () => {
  const phase = (id: string): Part[] => [read(`${id}a`, 'a.ts'), read(`${id}b`, 'b.ts')];

  const blocksOf = (parts: Part[]): PartBlock[] => groupMessageParts(parts);

  test('while it runs, the work before its newest phase rolls up once two phases lie there; the newest and its opening thought stay open', () => {
    const parts = [...phase('p1'), said('Found it.'), ...phase('p2'), said('Fixed.'), thought('Now staging'), ...phase('p3')];

    expect(laidOut(rollUpTurn(blocksOf(parts), true))).toEqual([
      { turn: [{ run: ['p1a', 'p1b'] }, { part: 'text' }, { run: ['p2a', 'p2b'] }, { part: 'text' }] },
      { reasoning: 'Now staging' }, { run: ['p3a', 'p3b'] },
    ]);
  });

  test('one phase before the newest is a line already, so nothing rolls up', () => {
    const blocks = blocksOf([...phase('p1'), said('Found it.'), ...phase('p2')]);

    expect(rollUpTurn(blocks, true)).toEqual(blocks);
  });

  test('once it has run, all its work rolls up and the answer stands after it', () => {
    const parts = [thought('Read first'), ...phase('p1'), said('Found it.'), ...phase('p2'), thought('All green'), said('Fixed and tested.')];

    expect(laidOut(rollUpTurn(blocksOf(parts), false))).toEqual([
      { turn: [{ reasoning: 'Read first' }, { run: ['p1a', 'p1b'] }, { part: 'text' }, { run: ['p2a', 'p2b'] }] },
      { reasoning: 'All green' }, { part: 'text' },
    ]);
  });

  test('a question for the owner is never rolled up: it splits the line in two', () => {
    const parts = [...phase('p1'), said('a'), ...phase('p2'), ask, ...phase('p3'), said('b'), ...phase('p4'), said('Done.')];

    expect(laidOut(rollUpTurn(blocksOf(parts), false))).toEqual([
      { turn: [{ run: ['p1a', 'p1b'] }, { part: 'text' }, { run: ['p2a', 'p2b'] }] }, { part: 'ask' },
      { turn: [{ run: ['p3a', 'p3b'] }, { part: 'text' }, { run: ['p4a', 'p4b'] }] }, { part: 'text' },
    ]);
  });
});

describe("a phase's line", () => {
  test('names the outcome first: a deploy, then the files edited and the tests, then the files read', () => {
    const titled = (parts: Part[]) => phaseTitle(parts.flatMap((part) => ('toolCallId' in part ? [part] : [])));

    expect(titled([shell('m', 'bunx wrangler d1 migrations apply SESSIONS_DB --env staging --remote', 'ok'), shell('d', 'bunx wrangler deploy --env staging', 'Deployed'), shell('h', 'curl -s https://staging/api/health', '{"ok":true}')]))
      .toBe('Deployed to staging and checked it');
    expect(titled([read('r', 'src/db.ts'), edit('e1', 'src/db.ts'), edit('e2', 'src/env.d.ts'), failed('t1'), shell('t2', 'bun test', '41 pass, 0 fail')]))
      .toBe('Edited db.ts and env.d.ts');
    expect(titled([edit('e1', 'src/db.ts'), shell('t2', 'bun test', '41 pass, 0 fail')])).toBe('Edited db.ts, 41 tests pass');
    expect(titled([shell('l', 'bunx wrangler tail api --status error', '500'), read('r1', 'src/db.ts'), read('r2', 'wrangler.jsonc'), search('s')]))
      .toBe('Read the logs, db.ts and wrangler.jsonc');
  });

  test('while the phase runs, says what it has done so far and what is running now', () => {
    const [block] = groupMessageParts([read('c1', 'src/db.ts'), read('c2', 'wrangler.jsonc'), running('c3', 'src/routes/admin.ts')]);

    if (block?.kind !== 'run') throw new Error('no phase');
    expect(toolRunSummary(block.steps)).toEqual({ calls: 3, failed: 0, title: 'Read db.ts and wrangler.jsonc', now: 'Reading admin.ts' });
  });

  test("a model's lines are read by each phase's first call, and a malformed one is no line", () => {
    const written = writtenTitles({ metadata: { [PHASE_TITLES_METADATA_KEY]: { p1a: 'Found the renamed D1 binding' }, [TURN_TITLE_METADATA_KEY]: 'Fixed and shipped the Worker' } });

    expect([...written.phases]).toEqual([['p1a', 'Found the renamed D1 binding']]);
    expect(written.turn).toBe('Fixed and shipped the Worker');
    expect(writtenTitles({ metadata: { [PHASE_TITLES_METADATA_KEY]: { p1a: 7 } } })).toEqual({ phases: new Map(), turn: null });
  });
});
