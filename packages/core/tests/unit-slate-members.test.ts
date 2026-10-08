import { expect, test } from 'bun:test';
import { slateAddressImpact } from '../src/slates/members';
import { toolCallEffect } from '../src/tools/tool-call-summary';

const impact = (namespace: string, member: string) => slateAddressImpact({ namespace, member });

test('the impact table is what the grant, the graph and the audit row read', () => {
  const rows: readonly [string, string, string][] = [
    ['workspace', 'readFile', 'observe'], ['workspace', 'readdir', 'observe'], ['sandbox', 'exists', 'observe'], ['workspace', 'stat', 'observe'],
    ['workspace', 'writeFile', 'mutate'], ['workspace', 'editFile', 'mutate'], ['workspace', 'mkdir', 'mutate'], ['workspace', 'remove', 'mutate'],
    ['workspace', 'exec', 'execute'], ['device', 'git', 'execute'],
    ['db', 'select', 'observe'], ['db', 'insert', 'mutate'], ['db', 'dropTable', 'mutate'],
    ['memory', 'search', 'observe'], ['memory', 'recall', 'observe'], ['memory', 'remember', 'mutate'], ['memory', 'forget', 'mutate'],
    ['tasks', 'list', 'observe'], ['tasks', 'add', 'mutate'],
    ['web', 'search', 'observe'], ['web', 'browsers', 'observe'], ['web', 'openBrowser', 'execute'], ['web', 'closeBrowser', 'mutate'],
    ['mcp.github', 'read_issue', 'externalSend'], ['tools', 'nightly_rollup', 'execute'], ['reads', 'getExecutors', 'observe'],
    ['slates.digest', 'count', 'observe'], ['agent', 'send', 'externalSend'], ['ai', 'run', 'execute'],
  ];

  for (const [namespace, member, expected] of rows) expect([namespace, member, impact(namespace, member)]).toEqual([namespace, member, expected]);

  // An executor member no table names fails closed, as the heaviest impact.
  expect(impact('workspace', 'reformatHardDrive')).toBe('administer');
  // A member the agent keeps from slates is not on the surface at all: switching its own role is one.
  expect(impact('tasks', 'mode')).toBeNull();
  expect(impact('memory', 'reformat')).toBeNull();
});

test('a native tool\'s chip reads the same impact a slate\'s call of that member is shown with', () => {
  for (const [tool, action] of [['memory', 'search'], ['memory', 'remember'], ['tasks', 'list'], ['tasks', 'add']] as const) {
    expect([tool, action, toolCallEffect(tool, { action })]).toEqual([tool, action, impact(tool, action) === 'observe' ? 'read' : 'mutate']);
  }

  expect(toolCallEffect('tasks', { action: 'mode', role: 'researcher' })).toBe('mutate');
  expect(toolCallEffect('tasks', { action: 'mode' })).toBe('read');
  expect(toolCallEffect('file', { action: 'read' })).toBe('read');
  expect(toolCallEffect('file', { action: 'write' })).toBe('mutate');
});
