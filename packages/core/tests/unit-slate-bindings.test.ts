import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { issuedSlateInvocation, routeSlateBindingCall, routeViewerBindingCall, SlateBindingRequestSchema, type SlateInvocation, type SlateViewer } from '../src/slates/bindings';
import type { ShareGrant } from '../src/slates/sharing';
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
  expect(() => routeApp('addItem', ['other'])).toThrow('re-enters slate other');
  expect(() => routeApp('addItem', ['other'])).toThrow('other -> notes -> other');
  // Long chains are not cycles.
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

  const resolve = (invocation: string | null) => issuedSlateInvocation({ invocations, id: 'notes', invocation })?.chain ?? [];
  // No issued invocation: the root, a preview hit rather than a hop.
  expect(resolve(null)).toEqual([]);
  expect(resolve('live')).toEqual(['root']);
  // A finished request's id cannot be replayed as an empty lineage.
  expect(() => resolve('retired')).toThrow('which this host is not running');
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
  expect(route('MODEL', 'shell', [{ prompt: 'sum this' }])).toEqual({ kind: 'ai', prompt: 'sum this' });
  expect(route('MODEL', 'shell', [{ prompt: 'p', system: 's', tier: 'deep' }])).toEqual({ kind: 'ai', prompt: 'p', system: 's', tier: 'deep' });
  expect(route('TUNED', 'shell', [{ prompt: 'p' }])).toEqual({ kind: 'ai', prompt: 'p', tier: 'fast' });
  expect(route('TUNED', 'shell', [{ prompt: 'p', tier: 'fast' }])).toEqual({ kind: 'ai', prompt: 'p', tier: 'fast' });

  expect(() => route('TUNED', 'shell', [{ prompt: 'p', tier: 'deep' }])).toThrow('pins tier fast');
  expect(() => route('MODEL', 'stream', [{ prompt: 'p' }])).toThrow('offers run');
  expect(() => route('MODEL', 'shell', [])).toThrow('takes one { prompt, system?, tier? } object');
  expect(() => route('MODEL', 'shell', [{ prompt: 4 }])).toThrow('takes one { prompt, system?, tier? } object');
});

test('a path-scoped workspace binding offers only file members inside its prefixes', () => {
  expect(route('FILES', 'readFile', ['/home/user/notes/a.md'])).toEqual({
    kind: 'namespace', namespace: 'workspace', member: 'readFile', args: ['/home/user/notes/a.md'],
  });
  expect(route('FILES', 'readdir', ['/home/user/notes'])).toMatchObject({ kind: 'namespace', member: 'readdir' });
  expect(route('FILES', 'exists', ['/home/user/shared/x'])).toMatchObject({ kind: 'namespace', member: 'exists' });

  expect(() => route('FILES', 'exec', ['/home/user/notes/a.md'])).toThrow('a path-scoped workspace binding offers only file members');
  expect(() => route('FILES', 'readFile', ['/etc/passwd'])).toThrow('outside its prefixes: /home/user/notes, /home/user/shared/');
  // A sibling sharing the prefix string is not inside it.
  expect(() => route('FILES', 'readFile', ['/home/user/notes2/x'])).toThrow('outside its prefixes');
  expect(() => route('FILES', 'readFile', ['/home/user/notes/../other'])).toThrow('outside its prefixes');
  expect(() => route('FILES', 'readFile', ['relative/path'])).toThrow('outside its prefixes');
  expect(() => route('FILES', 'readFile', [42])).toThrow('outside its prefixes');
  expect(() => route('FILES', 'readFile', [])).toThrow('outside its prefixes');
});

const viewerProject = parseSlateProject({
  main: 'server.js',
  slate: {
    bindings: {
      FILES: { kind: 'namespace', namespace: 'workspace', members: ['readFile', 'writeFile'] },
      GH: { kind: 'mcp', server: 'github', tools: ['read_issue', 'create_issue'] },
      INBOX: { kind: 'agent' },
      PEER: { kind: 'app', id: 'digest' },
      SHY: { kind: 'app', id: 'elsewhere' },
    },
  },
});

const viewer: SlateViewer = { share: 's1', subject: 'user:u7', request: 41 };

const viewerGrant: ShareGrant = {
  slates: ['issues', 'digest'],
  members: [
    { slate: 'issues', binding: 'FILES', member: 'readFile', effect: 'read' },
    { slate: 'issues', binding: 'GH', member: 'read_issue', effect: 'read' },
    { slate: 'issues', binding: 'INBOX', member: 'send', effect: 'mutate' },
    { slate: 'digest', binding: 'D', member: 'readFile', effect: 'read' },
  ],
};

const viewerCall = (name: string, member: string, args: JsonValue[] = []) => routeViewerBindingCall({
  id: 'issues', project: viewerProject, name,
  request: { member, args, invocation: null },
  chain: [], viewer, grant: viewerGrant,
});

test('a viewer call refuses what the owner call refuses, then what the grant does not name', () => {
  // Undeclared bindings refuse byte-identically to the owner's own call.
  expect(() => viewerCall('NOPE', 'readFile', ['/a'])).toThrow('Slate issues no longer declares binding NOPE');
  expect(() => viewerCall('FILES', 'writeFile', ['/a', 'x'])).toThrow('Slate issues does not grant FILES.writeFile to viewers');
  expect(() => viewerCall('FILES', 'exec', ['/a'])).toThrow('does not offer workspace.exec');
});

test('a granted member routes with the effect the grant admits', () => {
  expect(viewerCall('FILES', 'readFile', ['/a'])).toEqual({
    route: { kind: 'namespace', namespace: 'workspace', member: 'readFile', args: ['/a'] },
    member: 'readFile', effect: 'read',
  });
  // readOnly lets the mcp lane enforce it.
  expect(viewerCall('GH', 'read_issue', [{ n: 1 }])).toEqual({
    route: { kind: 'mcp', server: 'github', tool: 'read_issue', args: { n: 1 }, readOnly: true },
    member: 'read_issue', effect: 'read',
  });
  expect(() => viewerCall('GH', 'create_issue', [{}])).toThrow('does not grant GH.create_issue to viewers');
  expect(viewerCall('INBOX', 'send', [{ text: 'hi' }])).toEqual({
    route: { kind: 'agent', slate: 'issues', text: 'hi', viewer: 'user:u7' },
    member: 'send', effect: 'mutate',
  });
});

test('an app hop admits only slates the grant walks', () => {
  expect(viewerCall('PEER', 'count')).toEqual({
    route: { kind: 'app', id: 'digest', method: 'count', args: [], chain: ['issues'] },
    member: 'count', effect: 'read',
  });
  expect(() => viewerCall('SHY', 'count')).toThrow('does not grant SHY.count to viewers');
});

test('issuedSlateInvocation returns the viewer the host recorded', () => {
  const invocations = new Map<string, SlateInvocation>([
    ['shared', { id: 'issues', chain: ['root'], viewer }],
    ['plain', { id: 'issues', chain: ['root'] }],
  ]);

  expect(issuedSlateInvocation({ invocations, id: 'issues', invocation: 'shared' }))
    .toEqual({ id: 'issues', chain: ['root'], viewer });
  expect(issuedSlateInvocation({ invocations, id: 'issues', invocation: 'plain' })).toEqual({ id: 'issues', chain: ['root'] });
  expect(issuedSlateInvocation({ invocations, id: 'issues', invocation: null })).toBeNull();
});

