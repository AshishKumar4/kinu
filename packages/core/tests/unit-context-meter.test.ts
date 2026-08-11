// The local context breakdown. The contract under test is honesty: exact
// character counts, a stated divisor, no scaling toward the provider's total,
// and no measurement invented for a step that had none.
import { describe, test, expect } from 'bun:test';
import type { ModelMessage } from 'ai';
import { measureContext, TurnContextMeter, DYNAMIC_CONTEXT_OPEN_TAG } from '../src/index.ts';

const user = (text: string): ModelMessage => ({ role: 'user', content: text });
const assistant = (text: string): ModelMessage => ({ role: 'assistant', content: text });

describe('measureContext', () => {
  test('splits the system prompt on its own section headings', () => {
    const system = 'the soul\nlives here\n## Runtime context\nbackend: cf\n## Delegation\nrungs';
    const { segments } = measureContext({ system, messages: [] });
    expect(segments.map((s) => [s.plane, s.label])).toEqual([
      ['system', 'Soul'],
      ['system', 'Runtime context'],
      ['system', 'Delegation'],
    ]);
    // Exact, not rounded: each block is its own characters.
    expect(segments[0]?.chars).toBe('the soul\nlives here'.length);
    expect(segments[1]?.chars).toBe('## Runtime context\nbackend: cf'.length);
  });

  test('measures each tool definition including its schema', () => {
    const tools = {
      file: { description: 'edit files', inputSchema: { type: 'object' } },
      run: { description: 'shell', inputSchema: { type: 'object' } },
    };
    const { segments } = measureContext({ tools, messages: [] });
    const toolRows = segments.filter((s) => s.plane === 'tools');
    expect(toolRows.map((s) => s.label)).toEqual(['file', 'run']);
    expect(toolRows[0]?.chars).toBe('file'.length + 'edit files'.length + '{"type":"object"}'.length);
  });

  test('folds messages by role and reports how many folded in', () => {
    const { segments } = measureContext({
      messages: [user('aa'), assistant('bbb'), user('cccc')],
    });
    const rows = segments.filter((s) => s.plane === 'messages');
    expect(rows).toEqual([
      { plane: 'messages', label: 'user', chars: 6, items: 2 },
      { plane: 'messages', label: 'assistant', chars: 3, items: 1 },
    ]);
  });

  test('ephemeral live-state blocks are their own plane, never conversation', () => {
    // They ride as user messages, but counting them as what the user said
    // would misattribute the runtime's own context pressure to the operator.
    const block = `${DYNAMIC_CONTEXT_OPEN_TAG} fingerprint="ab">\nstate\n</dynamic_context>`;
    const { segments } = measureContext({ messages: [user('hello'), user(block)] });
    expect(segments).toEqual([
      { plane: 'messages', label: 'user', chars: 5, items: 1 },
      { plane: 'ephemeral', label: 'dynamic_context', chars: block.length, items: 1 },
    ]);
  });

  test('structured content is measured as the JSON it is serialised to', () => {
    const message: ModelMessage = {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: '1', toolName: 'run', output: { type: 'text', value: 'ok' } }],
    };
    const { segments } = measureContext({ messages: [message] });
    expect(segments[0]?.chars).toBe(JSON.stringify(message.content).length);
  });

  test('the estimate names its own divisor and is never fitted to anything', () => {
    const m = measureContext({ system: 'abcdefgh', messages: [] });
    expect(m.measuredChars).toBe(8);
    expect(m.charsPerToken).toBe(4);
    expect(m.estimatedTokens).toBe(2);
  });

  test('measuredChars is exactly the sum of the segments', () => {
    const m = measureContext({
      system: 'soul\n## Delegation\nrungs',
      tools: { run: { description: 'shell', inputSchema: {} } },
      messages: [user('hi'), assistant('yo')],
    });
    expect(m.measuredChars).toBe(m.segments.reduce((sum, s) => sum + s.chars, 0));
  });

  test('an empty request measures as empty, not as missing', () => {
    const m = measureContext({ messages: [] });
    expect(m.segments).toEqual([]);
    expect(m.measuredChars).toBe(0);
    expect(m.estimatedTokens).toBe(0);
  });
});

describe('TurnContextMeter', () => {
  test('carries the turn constants into every step measurement', () => {
    const meter = new TurnContextMeter();
    meter.openTurn({ system: '## Delegation\nrungs', tools: { run: { description: 'x' } } });
    meter.measure([user('one')]);
    const first = meter.take();
    meter.measure([user('one'), assistant('two')]);
    const second = meter.take();
    // The system + tools ride every request; only the messages grew.
    expect(first?.segments.filter((s) => s.plane !== 'messages'))
      .toEqual(second?.segments.filter((s) => s.plane !== 'messages') ?? []);
    expect(second!.measuredChars).toBeGreaterThan(first!.measuredChars);
  });

  test('take() drains, so a step never reports the previous step\'s request', () => {
    const meter = new TurnContextMeter();
    meter.openTurn({ system: 'soul' });
    meter.measure([user('hi')]);
    expect(meter.take()).toBeDefined();
    expect(meter.take()).toBeUndefined();
  });

  test('a turn that never measured reports nothing rather than an empty request', () => {
    const meter = new TurnContextMeter();
    meter.openTurn({ system: 'soul' });
    expect(meter.take()).toBeUndefined();
  });

  test('reset clears the turn constants too', () => {
    const meter = new TurnContextMeter();
    meter.openTurn({ system: 'soul', tools: { run: { description: 'x' } } });
    meter.reset();
    meter.measure([user('hi')]);
    expect(meter.take()?.segments.map((s) => s.plane)).toEqual(['messages']);
  });
});
