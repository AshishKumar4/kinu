import { expect, test } from 'bun:test';
import { parseSlateProject, slateExecutorName } from '../src/slates/project';
import { routeSlateBindingCall } from '../src/slates/bindings';
import type { JsonValue } from '../src/utils/json';

test('misspelled Slate requirements fail instead of changing runtime or authority', () => {
  expect(() => parseSlateProject({ name: 'notes', main: './server.ts', slate: { runtme: 'node' } })).toThrow('slate.runtme');
  expect(() => parseSlateProject({ name: 'notes', main: './server.ts', slate: { bindings: { FILES: { kind: 'namespace', namespce: 'workspace' } } } })).toThrow('slate.bindings.FILES');
  const worker = parseSlateProject({ name: 'notes', main: './server.ts', browser: './ui.tsx', dependencies: { react: '19.1.0' } });
  expect(slateExecutorName(worker)).toBe('workspace');
  const project = parseSlateProject({ name: 'notes', scripts: { dev: 'vite', build: 'vite build' }, slate: { runtime: 'node', port: 5173 } });
  expect(slateExecutorName(project)).toBe('sandbox');
  expect(() => parseSlateProject({ name: 'notes', scripts: { dev: 'vite' }, slate: { runtime: 'node' } })).toThrow('slate.port');
});

test('binding declarations constrain each capability plane without inherited object members', async () => {
  const project = parseSlateProject({ main: 'server.js', slate: { bindings: {
    FILES: { kind: 'namespace', namespace: 'workspace', members: ['readFile'] },
    JOBS: { kind: 'rpc', methods: ['listBackgroundJobs'] },
    NOTES: { kind: 'mcp', server: 'notes', tools: ['read_note'] },
    PEER: { kind: 'slate', id: 'other' },
  } } });
  const call = async (name: string, member: string, args: JsonValue[] = []) =>
    routeSlateBindingCall({ id: 'notes', project, name, request: { member, args } });
  await expect(call('FILES', 'writeFile')).rejects.toMatchObject({ code: 'denied' });
  await expect(call('toString', 'readFile')).rejects.toMatchObject({ code: 'denied' });
  await expect(call('JOBS', 'listBackgroundJobs', [1])).rejects.toMatchObject({ code: 'bad_input' });
  await expect(call('NOTES', 'remove_note')).rejects.toMatchObject({ code: 'denied' });
  await expect(call('NOTES', 'read_note', [[]])).rejects.toMatchObject({ code: 'bad_input' });
  await expect(call('NOTES', 'read_note', [null])).rejects.toMatchObject({ code: 'bad_input' });
  expect(await call('PEER', 'api/count')).toMatchObject({ kind: 'slate', id: 'other', method: 'api/count' });
});
