import { expect, test } from 'bun:test';
import { parseSlateProject } from '../src/slates/project';
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
  expect(() => parseSlateProject({ main: 'server.js', slate: { bindings: { AGENT: { kind: 'agent' } } } })).toThrow('slate.bindings.AGENT.kind');
});
