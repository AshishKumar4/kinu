import { expect, test } from 'bun:test';
import { credentialedBindings, describeBindings, parseSlateProject } from '../src/slates/project';
import { routeSlateBindingCall } from '../src/slates/bindings';
import type { JsonValue } from '../src/utils/json';

test('misspelled Slate requirements fail instead of changing runtime or authority', () => {
  expect(() => parseSlateProject({ name: 'notes', main: './server.ts', slate: { runtme: 'node' } })).toThrow('slate.runtme');
  expect(() => parseSlateProject({ name: 'notes', main: './server.ts', slate: { bindings: { FILES: { kind: 'namespace', namespce: 'workspace' } } } })).toThrow('slate.bindings.FILES.namespce');
  expect(() => parseSlateProject({ name: 'notes', main: './server.ts', slate: { bindings: { PEER: { kind: 'slate', id: 'other' } } } })).toThrow('slate.bindings.PEER.kind');
  expect(() => parseSlateProject({ name: 'notes', scripts: { dev: 'vite' }, slate: { runtime: 'node' } })).toThrow('slate.port');
});

test('binding declarations constrain each capability plane without inherited object members', async () => {
  const project = parseSlateProject({ main: 'server.js', slate: { bindings: {
    FILES: { kind: 'namespace', namespace: 'workspace', members: ['readFile'] },
    JOBS: { kind: 'rpc', methods: ['listBackgroundJobs'] },
    NOTES: { kind: 'mcp', server: 'notes', tools: ['read_note'] },
    PEER: { kind: 'app', id: 'other' },
  } } });

  const call = async (name: string, member: string, args: JsonValue[] = [], chain: string[] = []) =>
    routeSlateBindingCall({ id: 'notes', project, name, request: { member, args, invocation: null }, chain });

  await expect(call('FILES', 'writeFile')).rejects.toMatchObject({ code: 'denied' });
  await expect(call('toString', 'readFile')).rejects.toMatchObject({ code: 'denied' });
  await expect(call('JOBS', 'listBackgroundJobs', [1])).rejects.toMatchObject({ code: 'bad_input' });
  await expect(call('NOTES', 'remove_note')).rejects.toMatchObject({ code: 'denied' });
  await expect(call('NOTES', 'read_note', [[]])).rejects.toMatchObject({ code: 'bad_input' });
  await expect(call('NOTES', 'read_note', [null])).rejects.toMatchObject({ code: 'bad_input' });
  expect(await call('PEER', 'count')).toEqual({ kind: 'app', id: 'other', method: 'count', args: [], chain: ['notes'] });
});

test('tool bindings accept native JSON input and projection bindings retain codemode members', () => {
  const project = parseSlateProject({ main: 'server.js', slate: { bindings: {
    FILE: { kind: 'tool', name: 'file' },
    WEB: { kind: 'web', members: ['fetch'] },
    MEMORY: { kind: 'memory' },
    TASKS: { kind: 'tasks' },
  } } });

  const call = (name: string, member: string, args: JsonValue[] = []) => routeSlateBindingCall({
    id: 'app', project, name, request: { member, args, invocation: null }, chain: [],
  });

  expect(call('FILE', 'call', [{ action: 'read', path: 'note' }])).toEqual({ kind: 'tool', name: 'file', input: { action: 'read', path: 'note' } });
  expect(() => call('FILE', 'read', [{}])).toThrow('offers call(input)');
  expect(() => call('FILE', 'call', [1])).toThrow('one JSON object');
  expect(() => call('FILE', 'call', [{}, {}])).toThrow('one JSON object');
  expect(call('WEB', 'fetch', ['https://example.test'])).toEqual({ kind: 'codemode', namespace: 'web', member: 'fetch', args: ['https://example.test'] });
  expect(() => call('WEB', 'search', ['x'])).toThrow('does not offer');
  expect(call('MEMORY', 'recall', ['key'])).toMatchObject({ kind: 'codemode', namespace: 'memory', member: 'recall' });
  expect(call('TASKS', 'list')).toMatchObject({ kind: 'codemode', namespace: 'tasks', member: 'list' });
  expect(() => parseSlateProject({ main: 'server.js', slate: { bindings: { BOGON: { kind: 'bogon' } } } })).toThrow('slate.bindings.BOGON.kind');
});

test('agent, ai and path-scoped bindings parse, and only the workspace namespace scopes paths', () => {
  const project = parseSlateProject({
    main: 'server.js',
    slate: {
      bindings: {
        INBOX: { kind: 'agent' },
        MODEL: { kind: 'ai' },
        TUNED: { kind: 'ai', tier: 'fast' },
        FILES: { kind: 'namespace', namespace: 'workspace', paths: ['/home/main/notes'] },
      },
    },
  });

  expect(project.slate.bindings.INBOX).toEqual({ kind: 'agent' });
  expect(project.slate.bindings.MODEL).toEqual({ kind: 'ai' });
  expect(project.slate.bindings.TUNED).toEqual({ kind: 'ai', tier: 'fast' });
  expect(project.slate.bindings.FILES).toEqual({ kind: 'namespace', namespace: 'workspace', paths: ['/home/main/notes'] });

  expect(() => parseSlateProject({ main: 'server.js', slate: { bindings: { X: { kind: 'namespace', namespace: 'memory', paths: ['/a'] } } } }))
    .toThrow('paths scope only a workspace namespace binding');
  expect(() => parseSlateProject({ main: 'server.js', slate: { bindings: { X: { kind: 'ai', tier: 'Not-A-Tier' } } } }))
    .toThrow('slate.bindings.X.tier');
});

test('the class contract is what a missing main names, and inline height is bounded', () => {
  expect(() => parseSlateProject({ name: 'notes' })).toThrow('class Slate extends SlateObject');
  expect(parseSlateProject({ main: 'server.ts' }).slate.inline).toEqual({ height: 320 });
  expect(parseSlateProject({ main: 'server.ts', slate: { inline: { height: 480 } } }).slate.inline).toEqual({ height: 480 });

  for (const height of [719.5, 800, 100]) {
    expect(() => parseSlateProject({ main: 'server.ts', slate: { inline: { height } } })).toThrow('slate.inline.height');
  }
});

test('a single-file slate names its browser module as its main module', () => {
  const project = parseSlateProject({ main: 'slate.tsx', browser: 'slate.tsx' });

  expect(project.main).toBe('slate.tsx');
  expect(project.browser).toBe('slate.tsx');
});

test('credentialedBindings is non-empty exactly for the kinds that reach the owner (S4)', () => {
  const declared = {
    namespace: { kind: 'namespace', namespace: 'workspace' },
    rpc: { kind: 'rpc', methods: ['listBackgroundJobs'] },
    mcp: { kind: 'mcp', server: 'github' },
    app: { kind: 'app', id: 'other' },
    tool: { kind: 'tool', name: 'file' },
    memory: { kind: 'memory' },
    tasks: { kind: 'tasks' },
    web: { kind: 'web' },
  } as const;

  const credentialedKinds = ['namespace', 'rpc', 'mcp', 'tool', 'memory', 'tasks', 'web'];

  for (const binding of Object.values(declared)) {
    const project = parseSlateProject({ main: 'server.js', slate: { bindings: { CAP: binding } } });
    const credentialed = credentialedBindings(project);

    expect(credentialed.length > 0).toBe(credentialedKinds.includes(binding.kind));
    expect(describeBindings(project)).toEqual([{ name: 'CAP', kind: binding.kind, target: expect.any(String), credentialed: credentialedKinds.includes(binding.kind) }]);
  }

  expect(credentialedBindings(parseSlateProject({ main: 'server.js' }))).toEqual([]);
  expect(describeBindings(parseSlateProject({ main: 'server.js', slate: { bindings: {
    NOTES: { kind: 'mcp', server: 'notes', tools: ['read_note'] }, DATA: { kind: 'rpc', methods: ['getExecutors', 'listTriggers'] },
  } } }))).toEqual([
    { name: 'NOTES', kind: 'mcp', target: 'notes', credentialed: true },
    { name: 'DATA', kind: 'rpc', target: 'getExecutors, listTriggers', credentialed: true },
  ]);
});
