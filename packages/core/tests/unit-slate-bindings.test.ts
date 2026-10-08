import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import * as v from 'valibot';
import { assertLandsWithin, issuedSlateInvocation, routeSlateBindingCall, routeViewerBindingCall, SlateBindingRequestSchema, type SlateInvocation, type SlateViewer } from '../src/slates/bindings';
import { createWorkspaceBundle } from './helpers';
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
      FILES: { kind: 'namespace', namespace: 'workspace', paths: ['/home/main/notes', '/home/main/shared/'] },
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
  expect(route('TUNED', 'run', [{ prompt: 'p', tier: 'fast' }])).toEqual({ kind: 'ai', prompt: 'p', tier: 'fast' });

  expect(() => route('TUNED', 'run', [{ prompt: 'p', tier: 'deep' }])).toThrow('pins tier fast');
  expect(() => route('MODEL', 'stream', [{ prompt: 'p' }])).toThrow('offers run');
  // A tool's name is not this binding's member: `shell` is the shell tool.
  expect(() => route('MODEL', 'shell', [{ prompt: 'p' }])).toThrow('offers run');
  expect(() => route('MODEL', 'run', [])).toThrow('takes one { prompt, system?, tier? } object');
  expect(() => route('MODEL', 'run', [{ prompt: 4 }])).toThrow('takes one { prompt, system?, tier? } object');
});

test('a path-scoped workspace binding offers only file members, on an absolute path it forwards resolved', () => {
  expect(route('FILES', 'readFile', ['/home/main/notes/./a.md', 'utf8'])).toEqual({
    kind: 'namespace', namespace: 'workspace', member: 'readFile', args: ['/home/main/notes/a.md', 'utf8'],
    within: ['/home/main/notes', '/home/main/shared'],
  });
  expect(() => route('FILES', 'exec', ['/home/main/notes/a.md'])).toThrow('a path-scoped workspace binding offers only file members');

  for (const args of [['relative/path'], [42], []]) {
    expect(() => route('FILES', 'readFile', args)).toThrow(expect.objectContaining({ code: 'denied' }));
  }
});

// 2026-10-04: a slate named its own space's file by its reference and was refused as a relative path.
test('a path-scoped workspace binding takes a reference to the own space, forwarded as the path it names', () => {
  expect(route('FILES', 'readFile', ['vfs://home/main/notes/a.md'])).toMatchObject({ args: ['/home/main/notes/a.md'] });
  expect(() => route('FILES', 'readFile', ['local://notes/a.md'])).toThrow(expect.objectContaining({ code: 'denied' }));
});

describe('a granted path is judged where it lands in the workspace namespace', () => {
  async function landsWithin(prefixes: readonly string[]) {
    const granted = parseSlateProject({ main: 'server.js', slate: { bindings: {
      FILES: { kind: 'namespace', namespace: 'workspace', paths: [...prefixes] },
    } } });

    const { filesystem } = await createWorkspaceBundle(new Database(':memory:')).session();
    const namespace = filesystem.vfs.as(CRED_SESSION_USER);

    return async (path: string) => {
      const call = routeSlateBindingCall({ id: 'app', project: granted, name: 'FILES', request: { member: 'readFile', args: [path], invocation: null }, chain: [] });

      if (call.kind !== 'namespace') throw new Error(`expected a namespace route, got ${call.kind}`);
      await assertLandsWithin(namespace, call);
    };
  }

  test('inside a prefix lands; a sibling, a parent segment or another tree does not', async () => {
    const lands = await landsWithin(['/home/main/notes', '/home/main/shared/']);

    for (const inside of ['/home/main/notes/a.md', '/home/main/shared', '/home/main/shared/x']) {
      expect(await lands(inside)).toBeUndefined();
    }

    for (const outside of ['/etc/passwd', '/home/main/notes2/x', '/home/main/notes/../other', '/home/main/shared2/x']) {
      await expect(lands(outside)).rejects.toMatchObject({ code: 'denied' });
    }
  });
});

const viewerProject = parseSlateProject({
  main: 'server.js',
  slate: {
    bindings: {
      FILES: { kind: 'namespace', namespace: 'workspace', members: ['readFile', 'writeFile'] },
      GH: { kind: 'mcp', server: 'github', tools: ['read_issue', 'create_issue'] },
      INBOX: { kind: 'agent' },
      BRAIN: { kind: 'ai' },
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
    { slate: 'issues', binding: 'BRAIN', member: 'run', effect: 'mutate' },
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
  expect(viewerCall('BRAIN', 'run', [{ prompt: 'p' }])).toEqual({ route: { kind: 'ai', prompt: 'p' }, member: 'run', effect: 'mutate' });
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

