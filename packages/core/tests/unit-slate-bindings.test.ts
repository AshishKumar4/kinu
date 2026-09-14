import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { SlateBindingRequestSchema, resolveSlateChain, routeSlateBindingCall, type SlateInvocation } from '../src/slates/bindings';
import { parseSlateProject } from '../src/slates/project';
import type { JsonValue } from '../src/utils/json';
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
    request: { member, args: [], invocation: null },
    chain,
  });
}

test('Slate bridge forwards only public method names and names its invocation', () => {
  for (const name of ['list', 'addItem', 'get_state', 'v2']) expect(isSlateMethodName(name)).toBe(true);

  for (const name of ['constructor', '_private', '#secret', 'a.b', '', 'x'.repeat(65)]) {
    expect(isSlateMethodName(name)).toBe(false);
  }

  expect(v.safeParse(SlateBindingRequestSchema, { member: 'list', args: [] }).success).toBe(false);
  expect(v.safeParse(SlateBindingRequestSchema, { member: 'list', args: [], invocation: '' }).success).toBe(false);
  expect(v.safeParse(SlateBindingRequestSchema, { member: 'list', args: [], chain: [] }).success).toBe(false);
  expect(v.safeParse(SlateBindingRequestSchema, { member: 'list', args: [], invocation: null }).success).toBe(true);
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
  expect(() => routeSlateBindingCall({ id: 'notes', project: selfBound, name: 'PEER', request: { member: 'addItem', args: [], invocation: null }, chain: [] }))
    .toThrow('re-enters slate notes');
});

test('a lineage comes from the host record, never from the caller', () => {
  const invocations = new Map<string, SlateInvocation>([
    ['live', { id: 'notes', chain: ['root'] }],
    ['other-slate', { id: 'shelf', chain: [] }],
  ]);

  const resolve = (invocation: string | null) => resolveSlateChain({ invocations, id: 'notes', invocation });
  // A request the host issued no invocation for is the root, which is a preview
  // hit rather than a hop.
  expect(resolve(null)).toEqual([]);
  expect(resolve('live')).toEqual(['root']);
  // Retained bindings from a request that has finished: the id is gone, so the
  // lineage cannot be replayed as an empty one.
  expect(() => resolve('retired')).toThrow('which this host is not running');
  // An id the host issued, but to somebody else.
  expect(() => resolve('other-slate')).toThrow('was issued to slate shelf');
});

const routed = parseSlateProject({
  main: 'server.js',
  slate: {
    bindings: {
      INBOX: { kind: 'agent' },
      MODEL: { kind: 'ai' },
      TUNED: { kind: 'ai', tier: 'fast' },
      FILES: { kind: 'namespace', namespace: 'workspace', paths: ['/home/user/notes', '/home/user/shared/'] },
    },
  },
});

const route = (name: string, member: string, args: JsonValue[]) => routeSlateBindingCall({
  id: 'notes', project: routed, name,
  request: { member, args, invocation: null },
  chain: [],
});

test('an agent binding routes one inbox message carrying its slate id', () => {
  expect(route('INBOX', 'send', [{ text: 'hi' }])).toEqual({ kind: 'agent', slate: 'notes', text: 'hi' });
  expect(route('INBOX', 'send', [{ text: 'hi', data: { n: 1 } }])).toEqual({ kind: 'agent', slate: 'notes', text: 'hi', data: { n: 1 } });

  expect(() => route('INBOX', 'forward', [{ text: 'hi' }])).toThrow('offers send');
  expect(() => route('INBOX', 'send', [])).toThrow('takes one { text, data? } object');
  expect(() => route('INBOX', 'send', ['hi'])).toThrow('takes one { text, data? } object');
  expect(() => route('INBOX', 'send', [{ text: '' }])).toThrow('takes one { text, data? } object');
  expect(() => route('INBOX', 'send', [{ text: 'a' }, { text: 'b' }])).toThrow('takes one { text, data? } object');
});

test('an ai binding routes one model call, and a declared tier pins it', () => {
  expect(route('MODEL', 'run', [{ prompt: 'sum this' }])).toEqual({ kind: 'ai', prompt: 'sum this' });
  expect(route('MODEL', 'run', [{ prompt: 'p', system: 's', tier: 'deep' }])).toEqual({ kind: 'ai', prompt: 'p', system: 's', tier: 'deep' });
  expect(route('TUNED', 'run', [{ prompt: 'p' }])).toEqual({ kind: 'ai', prompt: 'p', tier: 'fast' });
  // A call naming the pinned tier asks for nothing different, so it routes.
  expect(route('TUNED', 'run', [{ prompt: 'p', tier: 'fast' }])).toEqual({ kind: 'ai', prompt: 'p', tier: 'fast' });

  expect(() => route('TUNED', 'run', [{ prompt: 'p', tier: 'deep' }])).toThrow('pins tier fast');
  expect(() => route('MODEL', 'stream', [{ prompt: 'p' }])).toThrow('offers run');
  expect(() => route('MODEL', 'run', [])).toThrow('takes one { prompt, system?, tier? } object');
  expect(() => route('MODEL', 'run', [{ prompt: 4 }])).toThrow('takes one { prompt, system?, tier? } object');
});

test('a path-scoped workspace binding offers only file members inside its prefixes', () => {
  expect(route('FILES', 'readFile', ['/home/user/notes/a.md'])).toEqual({
    kind: 'namespace', namespace: 'workspace', member: 'readFile', args: ['/home/user/notes/a.md'],
  });
  // The prefix itself and a trailing-slash prefix both admit.
  expect(route('FILES', 'readdir', ['/home/user/notes'])).toMatchObject({ kind: 'namespace', member: 'readdir' });
  expect(route('FILES', 'exists', ['/home/user/shared/x'])).toMatchObject({ kind: 'namespace', member: 'exists' });

  expect(() => route('FILES', 'exec', ['/home/user/notes/a.md'])).toThrow('a path-scoped workspace binding offers only file members');
  expect(() => route('FILES', 'readFile', ['/etc/passwd'])).toThrow('outside its prefixes: /home/user/notes, /home/user/shared/');
  // A sibling that SHARES the prefix string is not inside it.
  expect(() => route('FILES', 'readFile', ['/home/user/notes2/x'])).toThrow('outside its prefixes');
  expect(() => route('FILES', 'readFile', ['/home/user/notes/../other'])).toThrow('outside its prefixes');
  expect(() => route('FILES', 'readFile', ['relative/path'])).toThrow('outside its prefixes');
  expect(() => route('FILES', 'readFile', [42])).toThrow('outside its prefixes');
  expect(() => route('FILES', 'readFile', [])).toThrow('outside its prefixes');
});

