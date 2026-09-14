import { buildSync, type Metafile } from 'esbuild';
import * as reactNs from 'react';
import type { Plugin } from 'vite';
import type { SlateVendor } from 'virtual:kinu-slate-vendor';

export type { SlateVendor } from 'virtual:kinu-slate-vendor';

/**
 * The bytes a slate's two halves run on: the browser React bundle the import
 * map serves, the same export list as an all-undefined stub for the server
 * build, and capnweb twice — once for the browser (`import` condition,
 * `dist/index.js`) and once for the dynamic worker (`workerd`, keeping
 * `cloudflare:workers` external).
 *
 * Built once per process: these bytes change with dependency versions, not
 * per slate, so every caller memoizes on this module.
 */

/**
 * React 19 ships CJS only, so `export * from "react"` is invisible to
 * esbuild's name analysis (the index forwards through `require()`). The names
 * are enumerated off the INSTALLED module's namespace instead — the bundle
 * can never publish a name the package does not carry, and the stub below can
 * never declare one the bundle does not publish.
 */
const REACT_ENTRY = [
  'import * as __react from "react";',
  ...Object.keys(reactNs)
    .filter((name) => /^[a-zA-Z_$][\w$]*$/u.test(name) && name !== 'default' && name !== 'Fragment')
    .map((name) => `export const ${name} = __react.${name};`),
  'export { default } from "react";',
  'export { createRoot, hydrateRoot } from "react-dom/client";',
  'export { jsx, jsxs, Fragment } from "react/jsx-runtime";',
].join('\n');


function bundle(stdin: string, conditions: readonly string[], external: readonly string[] = []) {
  const result = buildSync({
    stdin: { contents: stdin, resolveDir: import.meta.dirname, loader: 'js' },
    bundle: true, write: false, format: 'esm', platform: 'browser',
    minify: true, metafile: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    conditions: [...conditions],
    external: [...external],
  });

  const text = result.outputFiles[0]?.text;

  if (text === undefined) throw new Error('slate vendor build produced no output');

  return { text, metafile: result.metafile };
}

/** The export names of the bundle's single output, in the metafile's order. */
function exportNames(metafile: Metafile): string[] {
  for (const output of Object.values(metafile.outputs)) return [...output.exports];

  return [];
}

/** The external specifiers the bundle's inputs still import — the real
 *  module graph's edges out of this bundle. */
function importSpecifiers(metafile: Metafile): string[] {
  const specifiers = new Set<string>();

  for (const input of Object.values(metafile.inputs)) {
    for (const entry of input.imports) {
      if (entry.external === true) specifiers.add(entry.path);
    }
  }

  return [...specifiers].sort();
}

export function buildSlateVendor(): SlateVendor {
  const react = bundle(REACT_ENTRY, ['browser', 'import']);
  const reactExports = exportNames(react.metafile);

  const reactStub = [
    ...reactExports.filter((name) => name !== 'default').map((name) => `export const ${name} = undefined;`),
    'export default undefined;',
    '',
  ].join('\n');

  const capnweb = bundle('export * from "capnweb";', ['browser', 'import']);
  const capnwebWorkers = bundle('export * from "capnweb";', ['workerd', 'import'], ['cloudflare:*']);

  return {
    react: react.text, reactStub, capnweb: capnweb.text, capnwebWorkers: capnwebWorkers.text, reactExports,
    imports: {
      react: importSpecifiers(react.metafile),
      capnweb: importSpecifiers(capnweb.metafile),
      capnwebWorkers: importSpecifiers(capnwebWorkers.metafile),
    },
  };
}

let vendor: SlateVendor | undefined;

/** One build per process: `slateVendor()` (both configs) and the bun preload
 *  share this memoization, so the metafile exports the test reads are the
 *  same bytes the runner serves. */
function slateVendorBundle(): SlateVendor {
  vendor ??= buildSlateVendor();

  return vendor;
}

/** The id `vite.config.ts`'s plugin answers with generated data — a module
 *  with no imports of its own, which is how a graph walk outside Vite must
 *  read it too. */
export const SLATE_VENDOR_ID = 'virtual:kinu-slate-vendor';

const RESOLVED_ID = '\0virtual:kinu-slate-vendor';

/** The Vite half of the virtual module — vite.config.ts and vitest.config.ts
 *  both register it so dev, build and the workerd pool resolve the same id. */
export function slateVendor(): Plugin {
  return {
    name: 'kinu:slate-vendor',
    resolveId: (id: string) => {
      if (id === SLATE_VENDOR_ID) return RESOLVED_ID;

      return null;
    },
    load: (id: string) => {
      if (id !== RESOLVED_ID) return null;

      return `export default ${JSON.stringify(slateVendorBundle())};`;
    },
  };
}
