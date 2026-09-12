import { describe, test, expect } from 'bun:test';
import type { ReasoningUIPart, TextUIPart, ToolUIPart, UIMessage } from 'ai';
import type { JsonObject, JsonValue } from '@kinu.run/core';
import { groupMessageParts, partEffect } from '../src/components/tool-call-grouping';
import { describeCommand, describeToolCall, toolCallEffect } from '@kinu.run/core';

type Part = UIMessage['parts'][number];

type TestToolState = 'input-available' | 'output-available' | 'output-error';

function tool(
  id: string,
  name: string,
  state: TestToolState,
  input: JsonValue = { action: 'read' },
): ToolUIPart {
  const type: `tool-${string}` = `tool-${name}`;

  if (state === 'output-available') {
    return { type, toolCallId: id, state, input, output: null };
  }

  if (state === 'output-error') {
    return { type, toolCallId: id, state, input, errorText: 'test failure' };
  }

  return { type, toolCallId: id, state, input };
}

const text = (content: string): TextUIPart => ({ type: 'text', text: content });

const kinds = (parts: readonly Part[]) =>
  groupMessageParts(parts).map((b) => (b.kind === 'tool-run' ? `run(${b.parts.length})` : b.part.type));

describe('tool effects follow the operation', () => {
  const cases: Array<{ name: string; input: JsonObject; effect: 'read' | 'mutate' }> = [
    { name: 'file', input: { action: 'write' }, effect: 'mutate' },
    { name: 'file', input: { action: 'edit' }, effect: 'mutate' },
    { name: 'file', input: { action: 'read' }, effect: 'read' },
    { name: 'memory', input: { action: 'save' }, effect: 'mutate' },
    { name: 'memory', input: { action: 'forget' }, effect: 'mutate' },
    { name: 'memory', input: { action: 'search' }, effect: 'read' },
    { name: 'memory', input: { action: 'recall' }, effect: 'read' },
    { name: 'tasks', input: { action: 'add' }, effect: 'mutate' },
    { name: 'tasks', input: { action: 'update' }, effect: 'mutate' },
    { name: 'tasks', input: { action: 'list' }, effect: 'read' },
    { name: 'web', input: { action: 'fetch' }, effect: 'mutate' },
    { name: 'web', input: { action: 'search' }, effect: 'read' },
    { name: 'agents', input: { action: 'hire' }, effect: 'mutate' },
    { name: 'agents', input: { action: 'list' }, effect: 'mutate' },
    { name: 'run', input: { command: 'touch notes.txt' }, effect: 'mutate' },
    { name: 'run', input: { command: 'bun test' }, effect: 'mutate' },
    { name: 'run', input: { command: 'curl https://example.com' }, effect: 'mutate' },
    { name: 'run', input: { command: 'ls -la' }, effect: 'read' },
    { name: 'run', input: { command: 'LC_ALL=C /usr/bin/rg needle src' }, effect: 'read' },
    { name: 'run', input: { command: 'git status --short' }, effect: 'read' },
    { name: 'run', input: { command: 'git commit -m fix' }, effect: 'mutate' },
    { name: 'run', input: { command: 'cat source > copy' }, effect: 'mutate' },
    { name: 'run', input: { command: 'ls; touch changed' }, effect: 'mutate' },
    { name: 'run', input: { command: 'rg --pre ./rewrite needle' }, effect: 'mutate' },
    { name: 'run', input: { command: 'git diff --output=changes.patch' }, effect: 'mutate' },
    { name: 'execute_tools', input: { code: 'await workspace.writeFile("a", "b")' }, effect: 'mutate' },
    { name: 'execute_tools', input: { code: 'return await workspace.readFile("a")' }, effect: 'mutate' },
  ];

  test.each(cases)('$name $input is $effect', ({ name, input, effect }) => {
    expect(toolCallEffect(name, input)).toBe(effect);
    expect(partEffect(tool('call', name, 'output-available', input))).toBe(effect);
  });

  test.each(['read', 'mutate'])('execute_tools uses its reported %s effect', (effect) => {
    const part: ToolUIPart = {
      type: 'tool-execute_tools', toolCallId: 'program', state: 'output-available',
      input: { code: 'return await workspace.readFile("a")' }, output: { result: { effect } },
    };

    expect(partEffect(part)).toBe(effect);
  });

  test('a top-level program effect is honored; source hints and invalid reports are not', () => {
    expect(toolCallEffect('execute_tools', {}, { effect: 'read' })).toBe('read');
    expect(toolCallEffect('execute_tools', {}, { effect: 'mutate' })).toBe('mutate');
    expect(toolCallEffect('execute_tools', { effect: 'read' }, { effect: 'unknown' })).toBe('mutate');
    expect(toolCallEffect('run', undefined)).toBe('mutate');
    expect(toolCallEffect('web_search', { query: 'docs' })).toBe('read');
  });
});

describe('grouping a turn into blocks', () => {
  test('finished reads group while delegation keeps its own card', () => {
    expect(kinds([
      text('found it'),
      tool('1', 'file', 'output-available'),
      tool('2', 'file', 'output-available'),
      tool('3', 'file', 'output-available'),
      tool('4', 'agents', 'output-available'),
      text('done'),
    ])).toEqual(['text', 'run(3)', 'tool-agents', 'text']);
  });

  test('step markers do not split a sequential tool run', () => {
    const step: Part = { type: 'step-start' };
    expect(kinds([
      step,
      tool('1', 'file', 'output-available'),
      step,
      tool('2', 'run', 'output-available', { command: 'ls' }),
      step,
      tool('3', 'file', 'output-available'),
    ])).toEqual(['run(3)']);
  });

  test('a call still running keeps its own row, and does not join the group', () => {
    expect(kinds([
      tool('1', 'file', 'output-available'),
      tool('2', 'file', 'output-available'),
      tool('3', 'file', 'output-available'),
      tool('4', 'run', 'input-available'),
    ])).toEqual(['run(3)', 'tool-run']);
  });

  test('a failed read groups in its original position', () => {
    expect(kinds([
      tool('1', 'file', 'output-available'),
      tool('2', 'file', 'output-error'),
      tool('3', 'file', 'output-available'),
    ])).toEqual(['run(3)']);
  });

  test('two adjacent finished calls share one bordered tool card', () => {
    expect(kinds([tool('1', 'file', 'output-available'), tool('2', 'file', 'output-available')]))
      .toEqual(['run(2)']);
  });

  test('text between two runs splits them', () => {
    expect(kinds([
      tool('1', 'file', 'output-available'), tool('2', 'file', 'output-available'), tool('3', 'file', 'output-available'),
      text('now the tests'),
      tool('4', 'run', 'output-available', { command: 'ls' }),
      tool('5', 'run', 'output-available', { command: 'cat notes.txt' }),
      tool('6', 'run', 'output-available', { command: 'git status' }),
    ])).toEqual(['run(3)', 'text', 'run(3)']);
  });

  test('non-tool parts are passed through untouched, in order', () => {
    const reasoning: ReasoningUIPart = { type: 'reasoning', text: 'hm' };
    expect(kinds([reasoning, text('a')]))
      .toEqual(['reasoning', 'text']);
  });

  test('a mutation splits adjacent runs of reads and keeps its own card', () => {
    expect(kinds([
      tool('1', 'file', 'output-available'), tool('2', 'file', 'output-available'),
      tool('3', 'file', 'output-available', { action: 'edit', path: 'a' }),
      tool('4', 'file', 'output-available'), tool('5', 'file', 'output-available'),
    ])).toEqual(['run(2)', 'tool-file', 'run(2)']);
  });

  test('a read that returned a preview never folds into activity', () => {
    const preview: ToolUIPart = {
      type: 'tool-file', toolCallId: 'preview', state: 'output-available',
      input: { action: 'read' }, output: { url: 'https://8789-kinu-app-p8789_ab12cd34.preview.example.test', port: 8789 },
    };

    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { querySelector: () => ({ content: 'preview.example.test' }) },
    });

    try {
      expect(kinds([
        tool('1', 'file', 'output-available'), tool('2', 'file', 'output-available'),
        preview,
        tool('4', 'file', 'output-available'), tool('5', 'file', 'output-available'),
      ])).toEqual(['run(2)', 'tool-file', 'run(2)']);
    } finally {
      if (previous) Object.defineProperty(globalThis, 'document', previous);
      else Reflect.deleteProperty(globalThis, 'document');
    }
  });

  test('an empty message yields no blocks', () => {
    expect(groupMessageParts([])).toEqual([]);
  });
});

describe('what a command is for, from its own argv', () => {
  test('the verb comes from the word the agent actually typed', () => {
    expect(describeCommand('bun test packages/checkout')).toBe('Ran tests');
    expect(describeCommand('npm run build')).toBe('Built');
    expect(describeCommand('bunx wrangler deploy --env staging')).toBe('Deployed');
    expect(describeCommand('tsc --noEmit -p packages/core')).toBe('Typechecked');
    expect(describeCommand('curl -s https://example.com')).toBe('Called an endpoint');
    expect(describeCommand('rg --json "coupon" packages/')).toBe('Searched the tree');
  });

  test('a leading path, env assignments and sudo do not hide the verb', () => {
    expect(describeCommand('/usr/local/bin/pytest -q')).toBe('Ran tests');
    expect(describeCommand('CI=1 NODE_ENV=test bun test')).toBe('Ran tests');
    expect(describeCommand('sudo make install')).toBe('Built');
  });

  test('git keeps its own verb rather than being flattened', () => {
    expect(describeCommand('git commit -m "fix"')).toBe('Git commit');
    expect(describeCommand('git push origin main')).toBe('Git push');
  });

  test('a command with no known verb says nothing rather than guessing', () => {
    expect(describeCommand('./scripts/weird-thing.sh --go')).toBe('');
    expect(describeCommand('')).toBe('');
    expect(describeCommand('   ')).toBe('');
  });
});

describe('what a call does, from its own arguments', () => {
  test('file reads by operation and the name a person reads', () => {
    expect(describeToolCall('file', { action: 'read', path: 'packages/checkout/src/apply-coupon.ts' }))
      .toBe('Read apply-coupon.ts');
    expect(describeToolCall('file', { action: 'write', path: 'a/b/c.test.ts' })).toBe('Wrote c.test.ts');
    expect(describeToolCall('file', { action: 'edit', path: 'x.sql' })).toBe('Edited x.sql');
    expect(describeToolCall('file', { action: 'list' })).toBe('Listed');
  });

  test('agents reports the fan-out it was actually given', () => {
    expect(describeToolCall('agents', { action: 'fork', forks: [{}, {}, {}] }))
      .toBe('Delegated to 3 parallel forks');
    expect(describeToolCall('agents', { action: 'fork', forks: [{}] })).toBe('Delegated to 1 parallel fork');
    expect(describeToolCall('agents', { action: 'fork' })).toBe('Delegated to a fork');
    expect(describeToolCall('agents', { action: 'hire', agent: 'scout' })).toBe('Asked scout');
    expect(describeToolCall('agents', { action: 'hire', scope: 'workspace' })).toBe('Hired a workspace');
  });

  test('an unknown action or unknown tool describes nothing', () => {
    expect(describeToolCall('file', { action: 'chmod', path: 'a' })).toBe('');
    expect(describeToolCall('some_mcp_tool', { anything: 'here' })).toBe('');
    expect(describeToolCall('run', { command: 42 })).toBe('');
    expect(describeToolCall('file', 'not an object')).toBe('');
  });
});

