import { expect, test } from 'bun:test';
import { toolActionEffect, toolActionMember, toolMembers } from '../src/slates/members';

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
});
