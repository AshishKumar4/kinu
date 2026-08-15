// host.history — the scaffold's read-only view of the conversation it is the
// inference loop for.
//
// Until this existed a scaffold received one string (`task`) plus a prepared
// default stream, so it could not see the context it was supposed to be
// managing. The properties that matter are that the view is READ-ONLY (nothing
// a scaffold does through it changes the history) and BUDGETED (no query, however
// asked, hands an unbounded page back across the sandbox boundary).
import { describe, test, expect } from 'bun:test';
import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import {
  SCAFFOLD_HISTORY_DEFAULT_LIMIT, SCAFFOLD_HISTORY_MAX_LIMIT,
  SCAFFOLD_HISTORY_MAX_MESSAGE_CHARS, SCAFFOLD_HISTORY_MAX_PAGE_CHARS,
  createScaffoldHistory, runScaffold,
  type ScaffoldHistoryPage,
} from '../src/index.js';
import { SCAFFOLD_HOST_TYPES } from '../src/scaffold/executor.js';
import type { Executor } from '../src/types/primitives.js';
import type { JsonValue } from '../src/utils/json.js';
import { createTestRuntime } from './helpers.js';

function conversation(n: number): ModelMessage[] {
  return Array.from({ length: n }, (_, i): ModelMessage => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i} body`,
  }));
}

const ScaffoldHistoryPageSchema: v.GenericSchema<ScaffoldHistoryPage> = v.object({
  total: v.number(),
  offset: v.number(),
  entries: v.array(v.object({
    index: v.number(),
    role: v.string(),
    chars: v.number(),
    text: v.string(),
    truncated: v.boolean(),
  })),
  clipped: v.boolean(),
});

const read = (messages: ModelMessage[]) =>
  createScaffoldHistory(() => messages);

describe('createScaffoldHistory', () => {
  test('defaults to the tail — the recent end is what a turn is usually about', async () => {
    const page = await read(conversation(50))();
    expect(page.total).toBe(50);
    expect(page.entries).toHaveLength(SCAFFOLD_HISTORY_DEFAULT_LIMIT);
    expect(page.offset).toBe(50 - SCAFFOLD_HISTORY_DEFAULT_LIMIT);
    expect(page.entries.at(-1)?.index).toBe(49);
    expect(page.entries.at(-1)?.text).toBe('message 49 body');
  });

  test('a negative offset counts back from the end without asking how long it is', async () => {
    const page = await read(conversation(50))({ offset: -3, limit: 10 });
    expect(page.offset).toBe(47);
    expect(page.entries.map((e) => e.index)).toEqual([47, 48, 49]);
  });

  test('pages forward from an absolute offset', async () => {
    const page = await read(conversation(50))({ offset: 0, limit: 5 });
    expect(page.entries.map((e) => e.index)).toEqual([0, 1, 2, 3, 4]);
    expect(page.entries[0]!.role).toBe('user');
    expect(page.entries[1]!.role).toBe('assistant');
  });

  test('an empty history is a page, not a throw', async () => {
    const page = await read([])();
    expect(page).toEqual({ total: 0, offset: 0, entries: [], clipped: false });
  });

  test('an offset past the end returns nothing rather than wrapping', async () => {
    const page = await read(conversation(5))({ offset: 99, limit: 10 });
    expect(page.offset).toBe(5);
    expect(page.entries).toEqual([]);
  });
});

describe('the budget cannot be argued out of', () => {
  test('limit is clamped, however it is asked for', async () => {
    const messages = conversation(500);
    expect((await read(messages)({ offset: 0, limit: 9_999 })).entries.length)
      .toBeLessThanOrEqual(SCAFFOLD_HISTORY_MAX_LIMIT);
    expect((await read(messages)({ offset: 0, limit: 0 })).entries).toHaveLength(1);
    expect((await read(messages)({ offset: 0, limit: -5 })).entries).toHaveLength(1);
    expect((await read(messages)({ offset: 0, limit: 2.9 })).entries).toHaveLength(2);
  });

  test('a whole page is bounded even at the maximum per-message budget', async () => {
    const long: ModelMessage[] = Array.from({ length: 100 }, () => ({ role: 'user', content: 'x'.repeat(50_000) }));
    const page = await read(long)({ offset: 0, limit: SCAFFOLD_HISTORY_MAX_LIMIT, maxChars: 999_999 });
    const chars = page.entries.reduce((sum, e) => sum + e.text.length, 0);
    expect(chars).toBeLessThanOrEqual(SCAFFOLD_HISTORY_MAX_PAGE_CHARS + SCAFFOLD_HISTORY_MAX_MESSAGE_CHARS);
    expect(page.clipped).toBe(true);
    expect(page.entries.length).toBeLessThan(SCAFFOLD_HISTORY_MAX_LIMIT);
  });

  test('a truncated message says how much of it there was, so the scaffold can go and get it', async () => {
    const page = await read([{ role: 'user', content: 'HEAD'.padEnd(9_000, '.') + 'TAIL' }])({ offset: 0, maxChars: 200 });
    const entry = page.entries[0]!;
    expect(entry.truncated).toBe(true);
    expect(entry.chars).toBe(9_004);
    expect(entry.text.startsWith('HEAD')).toBe(true);
    expect(entry.text.endsWith('TAIL')).toBe(true);
  });

  test('a message barely over budget is still reported as truncated', async () => {
    // The omission marker makes a window LONGER than a message only slightly
    // over budget, so comparing lengths would call this one whole.
    const page = await read([{ role: 'user', content: 'y'.repeat(205) }])({ offset: 0, maxChars: 200 });
    expect(page.entries[0]!.text.length).toBeGreaterThan(205);
    expect(page.entries[0]!.truncated).toBe(true);
  });

  test('a message within budget is not reported as truncated', async () => {
    const page = await read([{ role: 'user', content: 'y'.repeat(200) }])({ offset: 0, maxChars: 200 });
    expect(page.entries[0]!.truncated).toBe(false);
    expect(page.entries[0]!.text).toBe('y'.repeat(200));
  });
});

describe('rendering', () => {
  test('prose is verbatim; tool traffic is named rather than dumped', async () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'find it' }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'run', input: { cmd: 'ls' } }] },
      {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 't1',
          toolName: 'run',
          output: { type: 'json', value: { ok: true } },
        }],
      },
    ] satisfies ModelMessage[];
    const page = await read(messages)({ offset: 0 });
    expect(page.entries[0]!.text).toBe('find it');
    expect(page.entries[1]!.text).toBe('[tool-call run {"cmd":"ls"}]');
    expect(page.entries[2]!.text).toBe('[tool-result run {"type":"json","value":{"ok":true}}]');
  });

  test('an unknown part is named, not dropped silently', async () => {
    const messages = [{
      role: 'user',
      content: [{ type: 'file', data: 'data:text/plain;base64,eA==', mediaType: 'text/plain' }],
    }] satisfies ModelMessage[];
    const page = await read(messages)({ offset: 0 });
    expect(page.entries[0]!.text).toBe('[file]');
  });

  test('the view is read-only — a page is a copy, and mutating it cannot reach the history', async () => {
    const messages = conversation(3);
    const page = await read(messages)({ offset: 0 });
    page.entries[0]!.text = 'tampered';
    expect((await read(messages)({ offset: 0 })).entries[0]!.text).toBe('message 0 body');
  });

  test('the source is read per call, so a scaffold sees the history as it stands when it looks', async () => {
    const messages = conversation(2);
    const history = read(messages);
    expect((await history({ offset: 0 })).total).toBe(2);
    messages.push({ role: 'user', content: 'later' });
    expect((await history({ offset: 0 })).total).toBe(3);
  });
});

// The bridge as the sandbox actually sees it: a `host` provider whose `fns`
// cross the codemode boundary. The scaffold body itself cannot run here (the
// executor is mocked), so the contract under test is the provider surface.
describe('the sandbox bridge', () => {
  async function callHostHistory(
    opts: { history?: NonNullable<Parameters<typeof runScaffold>[0]['history']> },
    query: JsonValue,
  ): Promise<JsonValue | undefined> {
    const { rt } = createTestRuntime();
    let returned: JsonValue | undefined;
    const executor: Executor = {
      languages: ['javascript'],
      execute: async (_code, providers) => {
        if (!Array.isArray(providers)) throw new Error('expected resolved scaffold providers');
        const host = providers.find((provider) => provider.name === 'host');
        if (!host) throw new Error('expected host provider');
        const history = host.fns.history;
        if (!history) throw new Error('expected host.history provider function');
        returned = await history(query);
        return { result: undefined };
      },
    };
    rt.executor = executor;
    await runScaffold({
      rt, task: 'anything', emit: () => undefined, llmStream: async function* () { yield ''; },
      scaffoldCodeOverride: 'async function run() {}',
      ...opts,
    });
    return returned;
  }

  test('the contract the scaffold is shown documents the capability and its bounds', () => {
    expect(SCAFFOLD_HOST_TYPES).toContain('function history(');
    expect(SCAFFOLD_HOST_TYPES).toContain('READ-ONLY');
  });

  test('the scaffold reaches a real page through host.history', async () => {
    const page = v.parse(ScaffoldHistoryPageSchema, await callHostHistory(
      { history: createScaffoldHistory(() => conversation(4)) }, { offset: 0 },
    ));
    expect(page.total).toBe(4);
    expect(page.entries.map((e) => e.text)).toEqual([
      'message 0 body', 'message 1 body', 'message 2 body', 'message 3 body',
    ]);
  });

  test('a junk query is defaulted, not thrown across the boundary', async () => {
    const page = v.parse(ScaffoldHistoryPageSchema, await callHostHistory(
      { history: createScaffoldHistory(() => conversation(4)) }, 'not-an-object',
    ));
    expect(page.entries).toHaveLength(4);
  });

  test('a runtime without the bridge says so rather than pretending the history is empty', async () => {
    expect(await callHostHistory({}, {})).toEqual({ error: 'host.history: unavailable in this runtime' });
  });
});
