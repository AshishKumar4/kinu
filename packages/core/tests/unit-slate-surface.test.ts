import { expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  issuedSlateInvocation, routeSlateCall, slateCallAddress, SlateCallRequestSchema, type SlateInvocation,
} from '../src/slates/surface';
import type { JsonValue } from '../src/utils/json';
import { isSlateMethodName } from '../src/slates/rpc';

const call = (path: string[], args: JsonValue[] = [], chain: string[] = []) => routeSlateCall({
  id: 'notes', request: { path, args, invocation: null }, chain,
});

test('Slate bridge forwards only public method names and names its invocation', () => {
  for (const name of ['list', 'addItem', 'get_state', 'v2']) expect(isSlateMethodName(name)).toBe(true);

  for (const name of ['constructor', '_private', '#secret', 'a.b', '', 'x'.repeat(65)]) {
    expect(isSlateMethodName(name)).toBe(false);
  }

  expect(v.safeParse(SlateCallRequestSchema, { path: ['list'], args: [] }).success).toBe(false);
  expect(v.safeParse(SlateCallRequestSchema, { path: ['list'], args: [], invocation: '' }).success).toBe(false);
  expect(v.safeParse(SlateCallRequestSchema, { path: [], args: [], invocation: null }).success).toBe(false);
  expect(v.safeParse(SlateCallRequestSchema, { path: ['a', 'b', 'c', 'd'], args: [], invocation: null }).success).toBe(false);
  expect(v.safeParse(SlateCallRequestSchema, { path: ['list'], args: [], invocation: null }).success).toBe(true);
});

test('a path names its namespace and member, a lone name the workspace executor\'s', () => {
  expect(slateCallAddress(['readFile'])).toEqual({ namespace: 'workspace', member: 'readFile' });
  expect(slateCallAddress(['memory', 'recall'])).toEqual({ namespace: 'memory', member: 'recall' });
  expect(slateCallAddress(['mcp', 'github', 'read_issue'])).toEqual({ namespace: 'mcp.github', member: 'read_issue' });
  expect(call(['readFile'], ['/a'])).toEqual({
    route: { kind: 'namespace', namespace: 'workspace', member: 'readFile', args: ['/a'] },
    address: { namespace: 'workspace', member: 'readFile' }, impact: 'observe',
  });
  expect(call(['memory', 'remember'], ['k', 'v'])).toMatchObject({ address: { namespace: 'memory', member: 'remember' }, impact: 'mutate' });
  expect(() => call(['mcp', 'github'])).toThrow('workspace.mcp.<name>.<member>');
  expect(() => call(['memory', 'recall', 'deep'])).toThrow('workspace.memory.<member>');
});

test('a call into another slate appends the caller and refuses a repeat as a cycle', () => {
  expect(call(['slates', 'other', 'addItem'], [], ['root', 'shelf'])).toMatchObject({
    route: { kind: 'app', id: 'other', method: 'addItem', args: [], chain: ['root', 'shelf', 'notes'] }, impact: 'observe',
  });
  expect(() => call(['slates', 'other', '_private'])).toThrow('not a method name the bridge forwards');
  expect(() => call(['slates', 'other', '$share'])).toThrow('not a method name the bridge forwards');
  expect(() => call(['slates', 'other', 'addItem'], [], ['other'])).toThrow('other -> notes -> other');
  expect(() => call(['slates', 'notes', 'addItem'])).toThrow('re-enters slate notes');
  // Long chains are not cycles.
  const deep = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  expect(call(['slates', 'other', 'addItem'], [], deep)).toMatchObject({ route: { kind: 'app', id: 'other', chain: [...deep, 'notes'] } });
});

test('a lineage comes from the host record, never from the caller', () => {
  const invocations = new Map<string, SlateInvocation>([
    ['live', { id: 'notes', chain: ['root'] }],
    ['other-slate', { id: 'shelf', chain: [] }],
  ]);

  const resolve = (invocation: string | null) => issuedSlateInvocation({ invocations, id: 'notes', invocation })?.chain ?? [];
  // No issued invocation: the root, a preview hit rather than a hop.
  expect(resolve(null)).toEqual([]);
  expect(resolve('live')).toEqual(['root']);
  // A finished request's id cannot be replayed as an empty lineage.
  expect(() => resolve('retired')).toThrow('which this host is not running');
  expect(() => resolve('other-slate')).toThrow('was issued to slate shelf');
});

test('agent.send routes one inbox message carrying its slate id', () => {
  expect(call(['agent', 'send'], [{ text: 'hi' }]).route).toEqual({ kind: 'agent', slate: 'notes', text: 'hi' });
  expect(call(['agent', 'send'], [{ text: 'hi', data: { n: 1 } }]).route).toEqual({ kind: 'agent', slate: 'notes', text: 'hi', data: { n: 1 } });

  for (const args of [[], ['hi'], [{ text: '' }], [{ text: 'a' }, { text: 'b' }]]) {
    expect(() => call(['agent', 'send'], args)).toThrow('agent.send takes one { text, data? } object');
  }
});

test('agent.ask routes the same message, asking for the agent\'s own reply', () => {
  expect(call(['agent', 'ask'], [{ text: 'hi', data: { n: 1 } }])).toMatchObject({
    route: { kind: 'agent', slate: 'notes', text: 'hi', data: { n: 1 }, ask: true }, address: { namespace: 'agent', member: 'ask' }, impact: 'externalSend',
  });
  expect(() => call(['agent', 'ask'], [{ text: '' }])).toThrow('agent.ask takes one { text, data? } object');
});

test('ai.run routes one model call, the tier the call names', () => {
  expect(call(['ai', 'run'], [{ prompt: 'sum this' }]).route).toEqual({ kind: 'ai', prompt: 'sum this' });
  expect(call(['ai', 'run'], [{ prompt: 'p', system: 's', tier: 'deep' }]).route).toEqual({ kind: 'ai', prompt: 'p', system: 's', tier: 'deep' });
  expect(() => call(['ai', 'run'], [])).toThrow('ai.run takes one { prompt, system?, tier? } object');
  expect(() => call(['ai', 'run'], [{ prompt: 4 }])).toThrow('ai.run takes one { prompt, system?, tier? } object');
  // The run tool's rename to `shell` is not the model call's.
  expect(() => call(['ai', 'shell'], [{ prompt: 'p' }])).toThrow(expect.objectContaining({ code: 'denied' }));
});

test('what only the agent does is refused before it is routed', () => {
  for (const path of [['agent', 'hire'], ['workspace', 'createTool'], ['computer', 'createTool'], ['workspace', 'slates'], ['report', 'send'], ['tasks', 'switchRole']]) {
    expect(() => call(path), path.join('.')).toThrow(expect.objectContaining({ code: 'denied' }));
  }

  // Helpers are the owner's own slate's to hire: routed as the act they are, and held to the owner by the host.
  expect(call(['agents', 'hire'], [{}])).toMatchObject({ address: { namespace: 'agents', member: 'hire' }, impact: 'delegate' });

  // Read models and the browser are the surface's; an unknown read model is not.
  expect(call(['reads', 'getExecutors']).route).toEqual({ kind: 'rpc', method: 'getExecutors' });
  expect(() => call(['reads', 'getSecrets'])).toThrow('reads has no getSecrets');
  expect(call(['web', 'browsers'])).toMatchObject({ impact: 'observe' });
});

test('issuedSlateInvocation returns the invocation the host recorded', () => {
  const invocations = new Map<string, SlateInvocation>([
    ['plain', { id: 'issues', chain: ['root'] }],
  ]);

  expect(issuedSlateInvocation({ invocations, id: 'issues', invocation: 'plain' })).toEqual({ id: 'issues', chain: ['root'] });
  expect(issuedSlateInvocation({ invocations, id: 'issues', invocation: null })).toBeNull();
});
