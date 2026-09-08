import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { SlateBindingRequestSchema, routeSlateBindingCall } from '../src/slates/bindings';
import { parseSlateProject } from '../src/slates/project';
import { isSlateMethodName } from '../src/slates/rpc';

const project = parseSlateProject({
  main: 'server.js',
  slate: { bindings: { PEER: { kind: 'app', id: 'other' } } },
});

function routeApp(member: string, chain: string[]) {
  return routeSlateBindingCall({
    id: 'notes',
    project,
    name: 'PEER',
    request: { member, args: [], chain },
  });
}

test('Slate bridge forwards only public method names and requires the caller chain', () => {
  for (const name of ['list', 'addItem', 'get_state', 'v2']) expect(isSlateMethodName(name)).toBe(true);
  for (const name of ['constructor', '_private', '#secret', 'a.b', '', 'x'.repeat(65)]) {
    expect(isSlateMethodName(name)).toBe(false);
  }
  expect(v.safeParse(SlateBindingRequestSchema, { member: 'list', args: [] }).success).toBe(false);
  expect(v.safeParse(SlateBindingRequestSchema, { member: 'list', args: [], chain: [''] }).success).toBe(false);
  expect(v.safeParse(SlateBindingRequestSchema, { member: 'list', args: [], chain: 'notes' }).success).toBe(false);
});

test('Slate app bindings append the caller and refuse a repeat as a cycle', () => {
  expect(routeApp('addItem', ['root', 'shelf'])).toEqual({
    kind: 'app', id: 'other', method: 'addItem', args: [], chain: ['root', 'shelf', 'notes'],
  });
  expect(() => routeApp('_private', [])).toThrow('not a method name the bridge forwards');
  // A two-app cycle is refused at the repeat, not after a hop count.
  expect(() => routeApp('addItem', ['other'])).toThrow('re-enters slate other');
  expect(() => routeApp('addItem', ['other'])).toThrow('other -> notes -> other');
  // A chain longer than the old bound of eight is not a cycle and is forwarded.
  const deep = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  expect(routeApp('addItem', deep)).toMatchObject({ kind: 'app', id: 'other', chain: [...deep, 'notes'] });
});

test('a Slate whose app binding names itself is refused on the first hop', () => {
  const selfBound = parseSlateProject({ main: 'server.js', slate: { bindings: { PEER: { kind: 'app', id: 'notes' } } } });
  expect(() => routeSlateBindingCall({ id: 'notes', project: selfBound, name: 'PEER', request: { member: 'addItem', args: [], chain: [] } }))
    .toThrow('re-enters slate notes');
});
