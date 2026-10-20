import { expect, test } from 'bun:test';
import { slateAddressImpact } from '../src/slates/members';
import { toolCallEffect } from '../src/tools/tool-call-summary';

const impact = (namespace: string, member: string) => slateAddressImpact({ namespace, member });

test('the impact table is what the grant, the graph and the audit row read', () => {
  const rows: readonly [string, string, string][] = [
    ['workspace', 'fs.text', 'observe'], ['workspace', 'fs.list', 'observe'], ['computer', 'fs.stat', 'observe'],
    ['workspace', 'fs.write', 'mutate'], ['workspace', 'exec', 'execute'], ['computer', 'exposePort', 'administer'],
    ['db', 'select', 'observe'], ['db', 'insert', 'mutate'], ['db', 'dropTable', 'mutate'],
    ['memory', 'search', 'observe'], ['memory', 'recall', 'observe'], ['memory', 'remember', 'mutate'], ['memory', 'forget', 'mutate'],
    ['tasks', 'list', 'observe'], ['tasks', 'add', 'mutate'],
    ['web', 'search', 'observe'], ['web', 'browsers', 'observe'], ['web', 'openBrowser', 'execute'], ['web', 'closeBrowser', 'mutate'],
    ['mcp.github', 'read_issue', 'externalSend'], ['tools', 'nightly_rollup', 'execute'], ['reads', 'getExecutors', 'observe'],
    ['slates.digest', 'count', 'observe'], ['agent', 'send', 'externalSend'], ['ai', 'run', 'execute'],
  ];

  for (const [namespace, member, expected] of rows) expect([namespace, member, impact(namespace, member)]).toEqual([namespace, member, expected]);

  // A member a host serves over its own tables is the catalog's too: `computer.resize` was declared for slates and
  // refused them (the SufficientKoala audit).
  expect(impact('computer', 'resize')).toBe('administer');
  // A member the catalog never declares fails closed: it is off a slate's surface.
  expect(impact('workspace', 'reformatHardDrive')).toBeNull();
  // A member the agent keeps from slates is not on the surface at all: switching its own role is one.
  expect(impact('tasks', 'switchRole')).toBeNull();
  expect(impact('memory', 'reformat')).toBeNull();
  // `ai` has the one model call; the run tool's `shell` rename is not it.
  expect(impact('ai', 'shell')).toBeNull();
});

test('a native tool\'s chip reads the same impact a slate\'s call of that member is shown with', () => {

  expect(toolCallEffect('tasks', { op: 'switchRole', role: 'researcher' })).toBe('mutate');
  expect(toolCallEffect('tasks', { op: 'role' })).toBe('read');
  expect(toolCallEffect('file', { op: 'read' })).toBe('read');
  expect(toolCallEffect('file', { op: 'write' })).toBe('mutate');
});
