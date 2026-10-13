import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import type { JsonValue } from '@kinu.run/core';
import { join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';
import { SLATE_CLIENT_MODULE } from '@kinu.run/core/slates';

// bun's own transpiler, in this process: an esbuild service would be a child the file leaves running.
const transpiler = new Bun.Transpiler({ loader: 'ts' });

// A substring assertion would pass over a name never imported, so this mounts the module under a DOM shim.
test('the client module evaluates and its surface answers under a DOM shim', async () => {
  const dir = scratchDir('kinu-slate-client');

  writeFileSync(join(dir, 'stubs.js'), [
    'export const createElement = () => null;',
    'export const useMemo = (fn) => fn();',
    'export const useSyncExternalStore = (_subscribe, read) => read();',
    'export const createRoot = () => ({ render() {} });',
    'export const newWebSocketRpcSession = () => ({ onRpcBroken() {} });',
  ].join('\n'));

  const source = transpiler.transformSync(
    SLATE_CLIENT_MODULE
      .replaceAll('"react-dom/client"', '"./stubs.js"')
      .replaceAll('"react"', '"./stubs.js"')
      .replaceAll('"capnweb"', '"./stubs.js"'),
  );

  const seen: string[] = [];

  const win = {
    location: new URL('https://slate.test/?kinu=' + encodeURIComponent(JSON.stringify({ origin: 'https://host.test', theme: 'light' }))),
    addEventListener() {},
    postMessage(data: JsonValue) { seen.push(JSON.stringify(data)); },
  };

  // Delete the keys, not leave them undefined: `ui-module-globals` installs its shim only when `window` is absent.
  const KEYS = ['window', 'document', 'WebSocket'] as const;
  const previous = new Map(KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

  Object.assign(globalThis, {
    window: Object.assign(win, { parent: win }),
    document: { documentElement: { style: { setProperty() {} }, dataset: {} }, referrer: '' },
    WebSocket: function () {},
  });

  writeFileSync(join(dir, 'slate.js'), source);

  try {
    const mod = await import(join(dir, 'slate.js'));

    expect(mod.useHostContext()).toMatchObject({ origin: 'https://host.test', theme: 'light' });
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
