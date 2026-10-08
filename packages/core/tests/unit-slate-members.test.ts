import { expect, test } from 'bun:test';
import {
  memberEffect, toolActionEffect, toolActionMember, toolMembers, TOOL_ACTION_EFFECTS,
} from '../src/slates/members';
import { FILE } from '../src/operations/file';
import { MEMORY } from '../src/operations/memory';
import { TASKS } from '../src/operations/tasks';
import { toolCallEffect } from '../src/tools/tool-call-summary';

test('the member table is what the grant, the graph and the audit row read', () => {
  const rows: readonly [Parameters<typeof memberEffect>[0], string, 'read' | 'mutate'][] = [
    ['namespace', 'readFile', 'read'], ['namespace', 'readdir', 'read'], ['namespace', 'exists', 'read'],
    ['namespace', 'stat', 'read'], ['namespace', 'listTools', 'read'],
    ['namespace', 'writeFile', 'mutate'], ['namespace', 'mkdir', 'mutate'],
    ['namespace', 'remove', 'mutate'], ['namespace', 'exec', 'mutate'],
    ['namespace', 'createTool', 'mutate'], ['namespace', 'slate', 'mutate'], ['namespace', 'git', 'mutate'],
    ['memory', 'search', 'read'], ['memory', 'recall', 'read'], ['memory', 'searchConversations', 'read'],
    ['memory', 'note', 'mutate'], ['memory', 'remember', 'mutate'], ['memory', 'forget', 'mutate'],
    ['tasks', 'list', 'read'], ['tasks', 'role', 'read'], ['tasks', 'add', 'mutate'], ['tasks', 'update', 'mutate'],
    ['web', 'search', 'read'], ['web', 'fetch', 'read'], ['web', 'screenshot', 'read'],
  ];

  for (const [kind, member, effect] of rows) {
    expect(memberEffect(kind, member)).toBe(effect);
  }

  for (const kind of ['namespace', 'memory', 'tasks', 'web'] as const) {
    // A member the table does not name fails closed.
    expect(memberEffect(kind, 'reformatHardDrive')).toBe('mutate');
  }

  // A slate never switches the agent's role, nor drives its browser.
  expect(memberEffect('tasks', 'switchRole')).toBe('mutate');
  expect(memberEffect('web', 'openBrowser')).toBe('mutate');

  // rpc members are read models; agent and ai members are always acts.
  expect(memberEffect('rpc', 'anything')).toBe('read');
  expect(memberEffect('rpc', 'dropTables')).toBe('read');
  expect(memberEffect('agent', 'send')).toBe('mutate');
  expect(memberEffect('agent', 'anything')).toBe('mutate');
  expect(memberEffect('ai', 'run')).toBe('mutate');
  expect(memberEffect('ai', 'anything')).toBe('mutate');
});

test('every operation a native tool offers is classified, and a share reads it as the tool does', () => {
  const pinned = (tool: string, ops: readonly string[]) => {
    for (const op of ops) {
      // A declared operation is classified ('unknown' is not an effect), and a share reads it the same way.
      expect(toolCallEffect(tool, { op })).toBe(toolActionEffect(tool, op));
    }
  };

  pinned('file', Object.keys(FILE));
  pinned('memory', Object.keys(MEMORY));
  pinned('tasks', Object.values(TASKS).map((op) => op.name));
  pinned('web', ['search', 'fetch', 'screenshot']);
  expect(toolCallEffect('tasks', { op: 'switchRole', role: 'researcher' })).toBe('mutate');
  expect(toolCallEffect('tasks', { op: 'role' })).toBe('read');

  // A single-call tool has no read shape: `call` is the only member and it mutates — `agents` included.
  for (const tool of ['shell', 'eval', 'report', 'agents']) {
    expect(toolMembers(tool)).toEqual(['call']);
    expect(toolActionEffect(tool, 'call')).toBe('mutate');
  }

  expect(TOOL_ACTION_EFFECTS.agents).toEqual({ call: 'mutate' });
});

test('tool member derivation reads the op, and unknown tools get call', () => {
  expect(toolActionMember('file', { op: 'read' })).toBe('read');
  expect(toolActionMember('file', { op: 'edit', path: '/a' })).toBe('edit');
  // No string op on a capability tool is still `call`.
  expect(toolActionMember('file', {})).toBe('call');
  expect(toolActionMember('file', { op: 7 })).toBe('call');
  // A single-call tool ignores whatever `op` says.
  expect(toolActionMember('shell', { command: 'ls' })).toBe('call');
  expect(toolActionMember('shell', { op: 'read' })).toBe('call');

  // A crafted tool this table does not know still gets its one member.
  expect(toolMembers('nightly_rollup')).toEqual(['call']);
  expect(toolActionEffect('nightly_rollup', 'call')).toBe('mutate');
  expect(toolMembers('file')).toEqual(Object.keys(FILE));
});
