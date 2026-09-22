import { expect, test } from 'bun:test';
import {
  memberEffect, toolActionEffect, toolActionMember, toolMembers, TOOL_ACTION_EFFECTS,
} from '../src/slates/members';
import {
  FILE_TOOL_ACTIONS, MEMORY_FACT_ACTIONS, MEMORY_NOTE_ACTIONS, replayPolicyFor, TASKS_TOOL_ACTIONS, WEB_TOOL_ACTIONS,
} from '../src/tools/registry';
import { toolCallEffect } from '../src/tools/tool-call-summary';
import type { JsonObject } from '../src/utils/json';

test('the member table is what the grant, the graph and the audit row read', () => {
  const rows: readonly [Parameters<typeof memberEffect>[0], string, 'read' | 'mutate'][] = [
    ['namespace', 'readFile', 'read'], ['namespace', 'readdir', 'read'], ['namespace', 'exists', 'read'],
    ['namespace', 'stat', 'read'], ['namespace', 'searchMemory', 'read'], ['namespace', 'listTools', 'read'],
    ['namespace', 'writeFile', 'mutate'], ['namespace', 'editFile', 'mutate'], ['namespace', 'mkdir', 'mutate'],
    ['namespace', 'remove', 'mutate'], ['namespace', 'exec', 'mutate'], ['namespace', 'saveNote', 'mutate'],
    ['namespace', 'createTool', 'mutate'], ['namespace', 'slate', 'mutate'], ['namespace', 'git', 'mutate'],
    ['memory', 'search', 'read'], ['memory', 'recall', 'read'], ['memory', 'conversations', 'read'],
    ['memory', 'save', 'mutate'], ['memory', 'remember', 'mutate'], ['memory', 'forget', 'mutate'],
    ['tasks', 'list', 'read'], ['tasks', 'add', 'mutate'], ['tasks', 'update', 'mutate'], ['tasks', 'mode', 'mutate'],
    ['web', 'search', 'read'], ['web', 'fetch', 'read'],
  ];

  for (const [kind, member, effect] of rows) {
    expect(memberEffect(kind, member)).toBe(effect);
  }

  for (const kind of ['namespace', 'memory', 'tasks', 'web'] as const) {
    // A member the table does not name fails closed.
    expect(memberEffect(kind, 'reformatHardDrive')).toBe('mutate');
  }

  // rpc members are read models; agent and ai members are always acts.
  expect(memberEffect('rpc', 'anything')).toBe('read');
  expect(memberEffect('rpc', 'dropTables')).toBe('read');
  expect(memberEffect('agent', 'send')).toBe('mutate');
  expect(memberEffect('agent', 'anything')).toBe('mutate');
  expect(memberEffect('ai', 'shell')).toBe('mutate');
  expect(memberEffect('ai', 'anything')).toBe('mutate');
});

test('the tool rows restate the native classification — pinned to the tools themselves', () => {
  // Every native action classifies here exactly as the tools' own
  // classification answers: replay-safe whole tools read, mutating contracts
  // mutate, and a per-action reading is read. This layer cannot import
  // tools/, so this pin is what keeps the restatement honest.
  const pinned = (tool: string, actions: readonly string[]) => {
    for (const action of actions) {
      // `tasks.mode` is an action that either reads or switches the role; the
      // member covers both forms, so the probe carries the mutating one.
      const probe: JsonObject = tool === 'tasks' && action === 'mode' ? { action, role: 'researcher' } : { action };
      const expected = replayPolicyFor(tool) === 'safe' || toolCallEffect(tool, probe) === 'read' ? 'read' : 'mutate';

      expect(toolActionEffect(tool, action)).toBe(expected);
    }
  };

  pinned('file', FILE_TOOL_ACTIONS);
  pinned('memory', [...MEMORY_NOTE_ACTIONS, ...MEMORY_FACT_ACTIONS]);
  pinned('tasks', TASKS_TOOL_ACTIONS);
  pinned('web', WEB_TOOL_ACTIONS);

  // A single-call tool has no read shape: `call` is the only member and it
  // mutates — `agents` included.
  for (const tool of ['shell', 'eval', 'report', 'agents']) {
    expect(toolMembers(tool)).toEqual(['call']);
    expect(toolActionEffect(tool, 'call')).toBe('mutate');
  }

  expect(TOOL_ACTION_EFFECTS.agents).toEqual({ call: 'mutate' });
});

test('tool member derivation reads the action, and unknown tools get call', () => {
  expect(toolActionMember('file', { action: 'read' })).toBe('read');
  expect(toolActionMember('file', { action: 'edit', path: '/a' })).toBe('edit');
  // No string action on a discriminating tool is still `call`.
  expect(toolActionMember('file', {})).toBe('call');
  expect(toolActionMember('file', { action: 7 })).toBe('call');
  // A single-call tool ignores whatever `action` says.
  expect(toolActionMember('shell', { command: 'ls' })).toBe('call');
  expect(toolActionMember('shell', { action: 'read' })).toBe('call');

  // A crafted tool this table does not know still gets its one member.
  expect(toolMembers('nightly_rollup')).toEqual(['call']);
  expect(toolActionEffect('nightly_rollup', 'call')).toBe('mutate');
  expect(toolMembers('file')).toEqual(['read', 'list', 'stat', 'search', 'write', 'edit']);
});

