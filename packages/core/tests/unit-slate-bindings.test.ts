import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { SlateBindingRequestSchema, routeSlateBindingCall } from '../src/slates/bindings';
import { parseSlateProject } from '../src/slates/project';
import { isSlateMethodName } from '../src/slates/rpc';

const project = parseSlateProject({
  main: 'server.js',
  slate: { bindings: { PEER: { kind: 'app', id: 'other' } } },
});

function routeApp(member: string, depth: number) {
  return routeSlateBindingCall({
    id: 'notes',
    project,
    name: 'PEER',
    request: { member, args: [], depth },
  });
}

test('Slate bridge forwards only public method names and requires caller depth', () => {
  for (const name of ['list', 'addItem', 'get_state', 'v2']) expect(isSlateMethodName(name)).toBe(true);
  for (const name of ['constructor', '_private', '#secret', 'a.b', '', 'x'.repeat(65)]) {
    expect(isSlateMethodName(name)).toBe(false);
  }
  expect(v.safeParse(SlateBindingRequestSchema, { member: 'list', args: [] }).success).toBe(false);
  expect(v.safeParse(SlateBindingRequestSchema, { member: 'list', args: [], depth: -1 }).success).toBe(false);
});

test('Slate app bindings retain caller depth and refuse cycles before forwarding', () => {
  expect(routeApp('addItem', 2)).toEqual({
    kind: 'app', id: 'other', method: 'addItem', args: [], depth: 2,
  });
  expect(() => routeApp('_private', 0)).toThrow('not a method name the bridge forwards');
  expect(() => routeApp('addItem', 8)).toThrow('app hop 9');
});
