import { expect, test } from 'bun:test';
import { build, transform } from 'esbuild';
import { writeFileSync } from 'node:fs';
import type { JsonValue } from '@kinu.run/core';
import { join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';
import { SLATE_CLIENT_MODULE } from '@kinu.run/core/slates';

// The client module is the `kinu:slate` import map target: the specifiers it
// imports are exactly what the shell maps, and every name it uses is imported.
test('the client module imports exactly react, react-dom/client and capnweb', async () => {
  const built = await build({
    stdin: { contents: SLATE_CLIENT_MODULE, loader: 'js', resolveDir: '.' },
    bundle: true, write: false, metafile: true, format: 'esm',
    external: ['react', 'react-dom/client', 'capnweb'],
  });

  expect(Object.keys(built.metafile.outputs)).toEqual(['stdin.js']);
  expect(built.metafile.inputs['<stdin>'].imports.map((i) => i.path).sort())
    .toEqual(['capnweb', 'react', 'react-dom/client']);
});

// A substring assertion would pass over a name never imported; this mounts the
// module for real under a DOM shim and calls the surface.
test('the client module evaluates and its surface answers under a DOM shim', async () => {
  const dir = scratchDir('kinu-slate-client');

  writeFileSync(join(dir, 'stubs.js'), [
    'export const createElement = () => null;',
    'export const useMemo = (fn) => fn();',
    'export const useSyncExternalStore = () => null;',
    'export const createRoot = () => ({ render() {} });',
    'export const newWebSocketRpcSession = () => ({ onRpcBroken() {} });',
  ].join('\n'));

  const source = await transform(
    SLATE_CLIENT_MODULE
      .replaceAll('"react-dom/client"', '"./stubs.js"')
      .replaceAll('"react"', '"./stubs.js"')
      .replaceAll('"capnweb"', '"./stubs.js"'),
    { format: 'esm', loader: 'ts' },
  );

  const seen: string[] = [];

  const win = {
    location: new URL('https://slate.test/?kinu={}'),
    addEventListener() {},
    postMessage(data: JsonValue) { seen.push(JSON.stringify(data)); },
  };

  // The DOM shim lives only for this import: later files import modules whose
  // top level reads the real window (`use-theme` calls `matchMedia`), and the
  // shared `ui-module-globals` helper installs its shim only when `window` is
  // ABSENT — so restoring has to delete the keys, not leave them undefined.
  const KEYS = ['window', 'document', 'WebSocket'] as const;
  const previous = new Map(KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

  Object.assign(globalThis, {
    window: Object.assign(win, { parent: win }),
    document: { documentElement: { style: { setProperty() {} }, dataset: {} }, referrer: '' },
    WebSocket: function () {},
  });

  writeFileSync(join(dir, 'slate.js'), source.code);

  try {
    const mod = await import(join(dir, 'slate.js'));

    expect(mod.slate.greet).toBeInstanceOf(Function);
    expect(mod.useHostContext).toBeInstanceOf(Function);
    mod.resize(400);

    expect(seen).toEqual([]); // parent === window: not embedded, nothing posts
  } finally {
    for (const key of KEYS) {
      const descriptor = previous.get(key);

      if (descriptor !== undefined) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
