// Folding a turn's parts into render blocks, and the annotation the chat
// shows instead of raw arguments.
//
// Two properties carry the feature: a run of finished calls collapses to one
// row, and a call still running never does — a headline that ticks between
// "4 calls" and "5 calls" while the agent works is worse than no headline.
import { describe, test, expect } from 'bun:test';
import type { UIMessage } from 'ai';
import { groupMessageParts } from '../src/components/tool-call-grouping.ts';
import { describeCommand, describeToolCall, summarizeToolRun } from '../src/components/tool-call-summary.ts';

type Part = UIMessage['parts'][number];

const tool = (id: string, name: string, state: string, input: unknown = {}): Part =>
  ({ type: `tool-${name}`, toolCallId: id, state, input }) as unknown as Part;
const text = (t: string): Part => ({ type: 'text', text: t }) as unknown as Part;

const kinds = (parts: readonly Part[]) =>
  groupMessageParts(parts).map((b) => (b.kind === 'tool-run' ? `run(${b.parts.length})` : b.part.type));

describe('grouping a turn into blocks', () => {
  test('a run of finished calls collapses to one block', () => {
    expect(kinds([
      text('found it'),
      tool('1', 'file', 'output-available'),
      tool('2', 'file', 'output-available'),
      tool('3', 'file', 'output-available'),
      tool('4', 'agents', 'output-available'),
      text('done'),
    ])).toEqual(['text', 'run(4)', 'text']);
  });

  test('a call still running keeps its own row, and does not join the group', () => {
    expect(kinds([
      tool('1', 'file', 'output-available'),
      tool('2', 'file', 'output-available'),
      tool('3', 'file', 'output-available'),
      tool('4', 'run', 'input-available'),
    ])).toEqual(['run(3)', 'tool-run']);
  });

  test('a failed call still groups — the group carries the error, and hiding\n     the row would hide the failure', () => {
    expect(kinds([
      tool('1', 'file', 'output-available'),
      tool('2', 'file', 'output-error'),
      tool('3', 'file', 'output-available'),
    ])).toEqual(['run(3)']);
  });

  test('too few calls to be worth a click stay as ordinary rows', () => {
    expect(kinds([tool('1', 'file', 'output-available'), tool('2', 'file', 'output-available')]))
      .toEqual(['tool-file', 'tool-file']);
  });

  test('text between two runs splits them', () => {
    expect(kinds([
      tool('1', 'file', 'output-available'), tool('2', 'file', 'output-available'), tool('3', 'file', 'output-available'),
      text('now the tests'),
      tool('4', 'run', 'output-available'), tool('5', 'run', 'output-available'), tool('6', 'run', 'output-available'),
    ])).toEqual(['run(3)', 'text', 'run(3)']);
  });

  test('non-tool parts are passed through untouched, in order', () => {
    expect(kinds([{ type: 'reasoning', text: 'hm' } as unknown as Part, text('a')]))
      .toEqual(['reasoning', 'text']);
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
    expect(describeToolCall('agents', { action: 'ask', agent: 'scout' })).toBe('Asked scout');
    expect(describeToolCall('agents', { action: 'staff', scope: 'workspace' })).toBe('Staffed the workspace');
  });

  test('an unknown action or unknown tool describes nothing', () => {
    expect(describeToolCall('file', { action: 'chmod', path: 'a' })).toBe('');
    expect(describeToolCall('some_mcp_tool', { anything: 'here' })).toBe('');
    expect(describeToolCall('run', { command: 42 })).toBe('');
    expect(describeToolCall('file', 'not an object')).toBe('');
  });
});

describe('the collapsed run headline', () => {
  test('tallies verbs, in the order the agent first did each thing', () => {
    expect(summarizeToolRun([
      { toolName: 'file', input: { action: 'read', path: 'a.ts' } },
      { toolName: 'file', input: { action: 'read', path: 'b.sql' } },
      { toolName: 'file', input: { action: 'edit', path: 'b.sql' } },
      { toolName: 'file', input: { action: 'write', path: 'c.test.ts' } },
      { toolName: 'agents', input: { action: 'fork', forks: [{}, {}, {}] } },
    ])).toBe('5 calls · Read ×2 · Edited · Wrote · Delegated');
  });

  test('a call whose arguments carry no verb falls back to its tool name', () => {
    expect(summarizeToolRun([
      { toolName: 'weather_mcp', input: { city: 'Berlin' } },
      { toolName: 'weather_mcp', input: { city: 'Paris' } },
      { toolName: 'file', input: { action: 'read', path: 'a.ts' } },
    ])).toBe('3 calls · weather_mcp ×2 · Read');
  });
});
