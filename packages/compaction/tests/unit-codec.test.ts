/** Codec contract: encode→decode is identity (byte-verbatim, same object
 *  references) for real ModelMessage histories, tool pairing folds calls and
 *  results into one item, pruned items drop their full native footprint, and
 *  identity is deterministic without message ids. */

import { describe, expect, test } from 'bun:test';
import { modelMessageSchema, type ModelMessage } from 'ai';
import * as v from 'valibot';
import {
  buildPlan,
  proteusCodec,
  proteusConventions,
  proteusSpec,
  transformTurns,
  type Item,
  type Turn,
} from '../src/index';
import { assistant, toolCall, toolMessage, toolResult, user } from './helpers';

function roundTrip(messages: ModelMessage[]): ModelMessage[] {
  return proteusCodec.decode(proteusCodec.encode(messages), messages);
}

function expectVerbatim(messages: ModelMessage[]): void {
  const decoded = roundTrip(messages);
  expect(decoded).toHaveLength(messages.length);
  for (let i = 0; i < messages.length; i++) expect(decoded[i]).toBe(messages[i]);
}

const richHistory: ModelMessage[] = [
  user('plain string user message'),
  {
    role: 'user',
    content: [
      { type: 'text', text: 'multi-part user' },
      { type: 'image', image: new Uint8Array([1, 2, 3]), mediaType: 'image/png' },
      { type: 'file', data: 'aGVsbG8=', mediaType: 'application/pdf', filename: 'doc.pdf' },
    ],
  },
  { role: 'assistant', content: 'string-content assistant reply' },
  assistant([
    { type: 'reasoning', text: 'thinking about the task' },
    { type: 'text', text: 'I will call two tools.' },
    toolCall('c1', 'run', { command: 'ls' }),
    toolCall('c2', 'web_fetch', { url: 'https://example.com' }),
  ]),
  toolMessage([toolResult('c1', 'run', 'file-a file-b'), toolResult('c2', 'web_fetch', '<html>page</html>')]),
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'cached reply' }],
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
  },
  user('follow-up question'),
];

describe('round-trip identity', () => {
  test('rich history re-emits every message as the same object', () => {
    expectVerbatim(richHistory);
  });

  test('provider-executed inline tool result stays inside its assistant message', () => {
    expectVerbatim([
      user('search please'),
      assistant([
        toolCall('ws1', 'web_search', { query: 'proteus' }),
        toolResult('ws1', 'web_search', 'results...'),
        { type: 'text', text: 'Found it.' },
      ]),
      user('thanks'),
    ]);
  });

  test('non-adjacent provider-executed results still round-trip verbatim', () => {
    expectVerbatim([
      assistant([
        toolCall('ws1', 'web_search', { query: 'proteus' }),
        { type: 'text', text: 'provider interstitial' },
        toolResult('ws1', 'web_search', 'results...'),
      ]),
    ]);
  });

  test('orphaned tool results and unknown roles survive as opaque', () => {
    const orphan = toolMessage([toolResult('missing', 'run', 'orphan output')]);
    const system: ModelMessage = { role: 'system', content: 'stray system note' };
    expectVerbatim([user('a'), orphan, system, assistant([{ type: 'text', text: 'ok' }]), user('b')]);
  });

  test('multiple tool messages answering one assistant turn fold and re-emit', () => {
    expectVerbatim([
      user('go'),
      assistant([toolCall('a', 'run', { command: 'x' }), toolCall('b', 'run', { command: 'y' })]),
      toolMessage([toolResult('a', 'run', 'out-a')]),
      toolMessage([toolResult('b', 'run', 'out-b')]),
      user('done?'),
    ]);
  });

  test('duplicate identical messages round-trip', () => {
    const dup = (): ModelMessage => user('same text');
    expectVerbatim([dup(), assistant([{ type: 'text', text: 'ok' }]), dup(), assistant([{ type: 'text', text: 'ok' }])]);
  });
});

describe('encode structure', () => {
  test('tool call + result pair as one item on the assistant turn', () => {
    const turns = proteusCodec.encode([
      user('go'),
      assistant([{ type: 'text', text: 'running' }, toolCall('c1', 'run', { command: 'ls' })]),
      toolMessage([toolResult('c1', 'run', 'out')]),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe('user');
    expect(turns[1].role).toBe('assistant');
    const kinds = turns[1].items.map((item) => item.kind);
    expect(kinds).toEqual(['text', 'tool']);
    const tool = requireToolItem(turns[1].items[1]);
    expect(tool.callId).toBe('c1');
    expect(proteusCodec.transcriptLine(tool)).toContain('out');
  });

  test('headless tool message forms its own assistant-role turn', () => {
    const turns = proteusCodec.encode([toolMessage([toolResult('x', 'run', 'out')]), user('hi')]);
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe('assistant');
    expect(turns[0].items[0].kind).toBe('opaque');
  });

  test('keys and stamps are deterministic across encodes and distinct across turns', () => {
    const messages = [user('one'), assistant([{ type: 'text', text: 'a' }]), user('one'), user('two')];
    const first = proteusCodec.encode(messages);
    const second = proteusCodec.encode(messages);
    expect(first.map((t) => t.key)).toEqual(second.map((t) => t.key));
    expect(first.map((t) => t.stamp)).toEqual(second.map((t) => t.stamp));
    // Duplicate content dedupes with an ordinal, so keys and stamps differ.
    expect(new Set(first.map((t) => t.key)).size).toBe(4);
    expect(new Set(first.map((t) => t.stamp)).size).toBe(4);
  });
});

describe('decode after pruning', () => {
  const messages: ModelMessage[] = [
    user('go'),
    assistant([
      { type: 'reasoning', text: 'let me think' },
      { type: 'text', text: 'calling tools' },
      toolCall('c1', 'run', { command: 'a' }),
      toolCall('c2', 'run', { command: 'b' }),
    ]),
    toolMessage([toolResult('c1', 'run', 'out-1'), toolResult('c2', 'run', 'out-2')]),
    user('next'),
  ];

  function encoded(): Turn[] {
    return proteusCodec.encode(messages);
  }

  test('removing the reasoning item drops only the reasoning part', () => {
    const turns = encoded();
    turns[1].items = turns[1].items.filter((item) => item.kind !== 'reasoning');
    const decoded = proteusCodec.decode(turns, messages);
    expect(decoded).toHaveLength(4);
    const rebuilt = decoded[1];
    if (rebuilt.role !== 'assistant' || isString(rebuilt.content)) throw new Error('unexpected structure');
    expect(rebuilt.content.map((part) => part.type)).toEqual(['text', 'tool-call', 'tool-call']);
    // Surviving parts are the same objects; untouched messages are verbatim.
    const original = messages[1];
    if (original.role !== 'assistant' || isString(original.content)) throw new Error('unexpected structure');
    expect(rebuilt.content[0]).toBe(original.content[1]);
    expect(decoded[0]).toBe(messages[0]);
    expect(decoded[2]).toBe(messages[2]);
    expect(decoded[3]).toBe(messages[3]);
  });

  test('removing one tool item drops its call part and its result part', () => {
    const turns = encoded();
    turns[1].items = turns[1].items.filter((item) => !(item.kind === 'tool' && item.callId === 'c1'));
    const decoded = proteusCodec.decode(turns, messages);
    const rebuiltAssistant = decoded[1];
    if (rebuiltAssistant.role !== 'assistant' || isString(rebuiltAssistant.content)) throw new Error('unexpected structure');
    expect(rebuiltAssistant.content.some((p) => p.type === 'tool-call' && p.toolCallId === 'c1')).toBe(false);
    expect(rebuiltAssistant.content.some((p) => p.type === 'tool-call' && p.toolCallId === 'c2')).toBe(true);
    const rebuiltTool = decoded[2];
    if (rebuiltTool.role !== 'tool') throw new Error('unexpected shape');
    expect(rebuiltTool.content).toHaveLength(1);
    expect(rebuiltTool.content[0].type === 'tool-result' && rebuiltTool.content[0].toolCallId).toBe('c2');
  });

  test('removing all tool items drops the emptied tool message entirely', () => {
    const turns = encoded();
    turns[1].items = turns[1].items.filter((item) => item.kind !== 'tool');
    const decoded = proteusCodec.decode(turns, messages);
    expect(decoded).toHaveLength(3);
    expect(decoded.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  test('synthetic items append as trailing text', () => {
    const turns = encoded();
    turns[1].items = [
      ...turns[1].items.filter((item) => item.kind === 'text'),
      { kind: 'synthetic', key: 'syn', text: '[tool calls/results cleared]' },
    ];
    const decoded = proteusCodec.decode(turns, messages);
    const rebuilt = decoded[1];
    if (rebuilt.role !== 'assistant' || isString(rebuilt.content)) throw new Error('unexpected structure');
    const last = rebuilt.content[rebuilt.content.length - 1];
    expect(last.type === 'text' && last.text).toBe('[tool calls/results cleared]');
  });

  test('a synthetic tool stub renders at the replaced tool position', () => {
    const ordered: ModelMessage[] = [
      assistant([
        { type: 'text', text: 'before' },
        toolCall('c1', 'run', { command: 'pwd' }),
        { type: 'text', text: 'after' },
      ]),
      toolMessage([toolResult('c1', 'run', '/workspace')]),
    ];
    const turns = proteusCodec.encode(ordered);
    const toolIndex = turns[0].items.findIndex((item) => item.kind === 'tool');
    turns[0].items[toolIndex] = {
      kind: 'synthetic',
      key: 'stub',
      text: '[tool:run] pwd — ok',
    };

    const decoded = proteusCodec.decode(turns, ordered);
    expect(decoded).toHaveLength(1);
    const rebuilt = decoded[0];
    if (rebuilt.role !== 'assistant' || isString(rebuilt.content)) throw new Error('unexpected structure');
    expect(rebuilt.content.map((part) => part.type === 'text' ? part.text : part.type)).toEqual([
      'before',
      '[tool:run] pwd — ok',
      'after',
    ]);
  });

  test('stubbing another tool preserves a non-adjacent inline result position', () => {
    const ordered: ModelMessage[] = [
      assistant([
        toolCall('a', 'web_search', { query: 'proteus' }),
        { type: 'text', text: 'between call and provider result' },
        toolResult('a', 'web_search', 'result-a'),
        toolCall('b', 'run', { command: 'pwd' }),
      ]),
      toolMessage([toolResult('b', 'run', '/workspace')]),
    ];
    const turns = proteusCodec.encode(ordered);
    const toolIndex = turns[0].items.findIndex(
      (item) => item.kind === 'tool' && item.callId === 'b',
    );
    turns[0].items[toolIndex] = {
      kind: 'synthetic',
      key: 'stub-b',
      text: '[tool:run] pwd — ok',
    };

    const decoded = proteusCodec.decode(turns, ordered);
    const rebuilt = decoded[0];
    if (rebuilt.role !== 'assistant' || isString(rebuilt.content)) throw new Error('unexpected structure');
    expect(rebuilt.content.map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'tool-call' || part.type === 'tool-result') return `${part.type}:${part.toolCallId}`;
      return part.type;
    })).toEqual([
      'tool-call:a',
      'between call and provider result',
      'tool-result:a',
      '[tool:run] pwd — ok',
    ]);
  });

  test('string-content assistant merges synthetic text into the string', () => {
    const stringHistory: ModelMessage[] = [user('q'), { role: 'assistant', content: 'plain answer' }];
    const turns = proteusCodec.encode(stringHistory);
    turns[1].items.push({ kind: 'synthetic', key: 'syn', text: 'note' });
    const decoded = proteusCodec.decode(turns, stringHistory);
    expect(decoded[1]).toEqual({ role: 'assistant', content: 'plain answer\n\nnote' });
  });

  test('ladder-synthesized turns render as user messages', () => {
    const synthetic: Turn = {
      key: 'ref',
      stamp: 0,
      role: 'user',
      items: [{ kind: 'synthetic', key: 'ref', text: '[Better Compact context pruning applied]' }],
    };
    const decoded = proteusCodec.decode([synthetic], []);
    expect(decoded).toEqual([{ role: 'user', content: '[Better Compact context pruning applied]' }]);
  });

  test('an oversized multipart user turn emits only the re-coalesced raw fragment', () => {
    const compacted = { type: 'text' as const, text: `old requirement ${'x'.repeat(72_000)}` };
    const raw = { type: 'text' as const, text: 'newest requirement stays raw' };
    const messages: ModelMessage[] = [{ role: 'user', content: [compacted, raw] }];
    const turns = proteusCodec.encode(messages);
    const plan = buildPlan(
      turns,
      {
        sessionKey: 'fragment-test',
        contextLimit: 10_000,
        targetRatio: 0.3,
        force: true,
        citablePath: (_sessionKey, hash) => `transcripts/${hash}.md`,
      },
      proteusSpec,
    );
    if (!plan) throw new Error('expected a split-turn plan');
    expect(plan.rawTailItemBoundary).toEqual({ itemKey: turns[0].items[1].key, side: 'before' });

    const transformed = transformTurns(turns, plan.rawTailStartIndex, plan, proteusSpec);
    const decoded = proteusCodec.decode(transformed, messages);
    const rebuilt = decoded.at(-1);
    if (!rebuilt || rebuilt.role !== 'user' || isString(rebuilt.content)) {
      throw new Error('expected a multipart raw-tail user message');
    }
    expect(rebuilt.content).toHaveLength(1);
    expect(rebuilt.content[0]).toBe(raw);
    expect(JSON.stringify(rebuilt)).not.toContain('old requirement');

    const transcript = proteusCodec.transcriptDocument?.(plan.transcript.turns ?? []) ?? '';
    expect(transcript).toContain('old requirement');
    expect(transcript).not.toContain('newest requirement stays raw');
  });
});

describe('estimation and transcripts', () => {
  test('text prices at chars/4 and media prices flat', () => {
    const textTurns = proteusCodec.encode([user('x'.repeat(4_000))]);
    expect(proteusCodec.estimateTurns(textTurns)).toBe(1_000);
    const imageTurns = proteusCodec.encode([
      { role: 'user', content: [{ type: 'image', image: new Uint8Array(1_000_000), mediaType: 'image/png' }] },
    ]);
    expect(proteusCodec.estimateTurns(imageTurns)).toBe(1_200);
  });

  test('a tool pair prices its input and output', () => {
    const turns = proteusCodec.encode([
      assistant([toolCall('c1', 'run', { command: 'x'.repeat(400) })]),
      toolMessage([toolResult('c1', 'run', 'y'.repeat(4_000))]),
    ]);
    const tool = requireToolItem(turns[0].items[0]);
    expect(proteusCodec.estimateItem(tool)).toBeGreaterThan(1_000);
  });

  test('transcriptLine renders tool input and output', () => {
    const turns = proteusCodec.encode([
      assistant([toolCall('c1', 'run', { command: 'make test' })]),
      toolMessage([toolResult('c1', 'run', 'all 42 tests passed')]),
    ]);
    const line = proteusCodec.transcriptLine(turns[0].items[0]);
    expect(line).toContain('[tool:run] callId=c1');
    expect(line).toContain('make test');
    expect(line).toContain('all 42 tests passed');
  });

  test('transcriptDocument is lossless JSON with binary flattened', () => {
    const messages: ModelMessage[] = [
      user('exact user wording'),
      {
        role: 'user',
        content: [
          { type: 'text', text: 'with image' },
          { type: 'image', image: new Uint8Array(5), mediaType: 'image/png' },
        ],
      },
      assistant([toolCall('c1', 'run', { command: 'ls -la' })]),
      toolMessage([toolResult('c1', 'run', 'total 12\ndrwxr-xr-x')]),
    ];
    const doc = proteusCodec.transcriptDocument?.(proteusCodec.encode(messages)) ?? '';
    expect(doc).toContain('exact user wording');
    expect(doc).toContain('ls -la');
    expect(doc).toContain('total 12\\ndrwxr-xr-x');
    expect(doc).toContain('[binary 5 bytes]');
    // Every fenced block parses back to the native message group.
    const blocks = [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)]
      .map((match) => parseMessageGroup(match[1]));
    expect(blocks).toHaveLength(3);
    expect(blocks[0][0]).toEqual({ role: 'user', content: 'exact user wording' });
    expect(blocks[2]).toHaveLength(2);
  });
});

describe('conventions', () => {
  test('skills read/invoke calls are skill items; other skills actions and tools are not', () => {
    const turns = proteusCodec.encode([
      assistant([
        toolCall('s1', 'skills', { action: 'read', name: 'deploy' }),
        toolCall('s2', 'skills', { action: 'list' }),
        toolCall('r1', 'run', { command: 'ls' }),
      ]),
    ]);
    const [read, list, run] = turns[0].items;
    expect(proteusConventions.isSkillItem?.(read)).toBe(true);
    expect(proteusConventions.isSkillItem?.(list)).toBe(false);
    expect(proteusConventions.isSkillItem?.(run)).toBe(false);
  });

  test('todo and itemNote conventions are intentionally absent', () => {
    expect(proteusConventions.todo).toBeUndefined();
    expect(proteusConventions.itemNote).toBeUndefined();
  });

  test('tool metadata exposes names, inputs, and explicit SDK errors', () => {
    const turns = proteusCodec.encode([
      assistant([toolCall('e1', 'workspace.readFile', { path: '/tmp/missing' })]),
      toolMessage([{
        type: 'tool-result',
        toolCallId: 'e1',
        toolName: 'workspace.readFile',
        output: { type: 'error-text', value: 'ENOENT: /tmp/missing' },
      }]),
    ]);
    const item = turns[0].items[0];
    if (item.kind !== 'tool') throw new Error('expected a tool item');
    expect(proteusConventions.tool?.(item)).toEqual({
      name: 'workspace.readFile',
      input: { path: '/tmp/missing' },
      error: 'ENOENT: /tmp/missing',
    });
  });

  test('ladder order enables skills, superseding, and error purging before old tools', () => {
    expect(proteusSpec.stages.map((stage) => stage.name)).toEqual([
      'skills',
      'supersede-reads',
      'purge-error-inputs',
      'tools-old',
      'reasoning',
      'tools-remaining',
      'assistant-runs',
    ]);
  });
});

function isString<Value>(value: Value): value is Value & string {
  return v.is(v.string(), value);
}

function isMessageGroup<Value>(value: Value): value is Value & ModelMessage[] {
  return Array.isArray(value)
    && value.every((message) => modelMessageSchema.safeParse(message).success);
}

function parseMessageGroup(json: string): ModelMessage[] {
  const parsed: unknown = JSON.parse(json);
  if (!isMessageGroup(parsed)) throw new Error('expected a model-message transcript group');
  return parsed;
}

function requireToolItem(item: Item | undefined): Extract<Item, { kind: 'tool' }> {
  if (!item || item.kind !== 'tool') throw new Error('expected a tool item');
  return item;
}
