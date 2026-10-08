import { expect, test } from 'bun:test';
import { parseSlateProject, slateTitle } from '../src/slates/project';

test('misspelled Slate requirements fail instead of changing runtime or authority', () => {
  expect(() => parseSlateProject({ name: 'notes', main: './server.ts', slate: { runtme: 'node' } })).toThrow('slate.runtme');
  expect(() => parseSlateProject({ name: 'notes', scripts: { dev: 'vite' }, slate: { runtime: 'node' } })).toThrow('slate.port');
});

test('package.json names no capabilities: a slate reaches its caller\'s surface, and a declared table is refused', () => {
  expect(() => parseSlateProject({ main: 'server.js', slate: { bindings: { FILES: { kind: 'namespace', namespace: 'workspace' } } } }))
    .toThrow('slate.bindings');
  expect(parseSlateProject({ main: 'server.js', slate: { title: 'Notes' } }).slate).toEqual({ runtime: 'worker', title: 'Notes' });
});

test('a slate needs no class, and its title is its slate.title or its directory', () => {
  expect(parseSlateProject({ browser: 'index.html' }).main).toBeUndefined();
  expect(slateTitle(parseSlateProject({ browser: 'index.html', slate: { title: 'Deploy checklist' } }), 'deploys')).toBe('Deploy checklist');
  expect(slateTitle(parseSlateProject({ browser: 'index.html' }), 'deploys')).toBe('deploys');
});

test('a single-file slate names its browser module as its main module', () => {
  const project = parseSlateProject({ main: 'slate.tsx', browser: 'slate.tsx' });

  expect(project.main).toBe('slate.tsx');
  expect(project.browser).toBe('slate.tsx');
});
