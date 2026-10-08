import { expect, test } from 'bun:test';
import { parseSlateProject } from '../src/slates/project';

test('misspelled Slate requirements fail instead of changing runtime or authority', () => {
  expect(() => parseSlateProject({ name: 'notes', main: './server.ts', slate: { runtme: 'node' } })).toThrow('slate.runtme');
  expect(() => parseSlateProject({ name: 'notes', scripts: { dev: 'vite' }, slate: { runtime: 'node' } })).toThrow('slate.port');
});

test('package.json names no capabilities: a slate reaches its caller\'s surface, and a declared table is refused', () => {
  expect(() => parseSlateProject({ main: 'server.js', slate: { bindings: { FILES: { kind: 'namespace', namespace: 'workspace' } } } }))
    .toThrow('slate.bindings');
  expect(parseSlateProject({ main: 'server.js', slate: { title: 'Notes' } }).slate).toEqual({ runtime: 'worker', title: 'Notes', inline: { height: 320 } });
});

test('a slate needs no class, and inline height is bounded', () => {
  expect(parseSlateProject({ name: 'notes', browser: 'index.html' }).main).toBeUndefined();
  expect(parseSlateProject({ main: 'server.ts' }).slate.inline).toEqual({ height: 320 });
  expect(parseSlateProject({ main: 'server.ts', slate: { inline: { height: 480 } } }).slate.inline).toEqual({ height: 480 });

  for (const height of [719.5, 800, 100]) {
    expect(() => parseSlateProject({ main: 'server.ts', slate: { inline: { height } } })).toThrow(expect.objectContaining({ code: 'bad_input' }));
  }
});

test('a single-file slate names its browser module as its main module', () => {
  const project = parseSlateProject({ main: 'slate.tsx', browser: 'slate.tsx' });

  expect(project.main).toBe('slate.tsx');
  expect(project.browser).toBe('slate.tsx');
});
