import { buildSync, type Metafile } from 'esbuild';
import * as reactNs from 'react';
import type { Plugin } from 'vite';

/** Vendored react/capnweb bytes for the slate runner; `src/slate-vendor.d.ts` mirrors this shape. */
export interface SlateVendor {
  readonly react: string;
  readonly reactStub: string;
  readonly capnweb: string;
  readonly capnwebWorkers: string;
  /** External specifiers per bundle, from the metafile. */
  readonly imports: { readonly react: readonly string[]; readonly capnweb: readonly string[]; readonly capnwebWorkers: readonly string[] };
  /** `react` export names, from the metafile. */
  readonly reactExports: readonly string[];
}

/** React ships CJS, so esbuild cannot see `export *` names; enumerate them off the installed module. */
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

function exportNames(metafile: Metafile): string[] {
  for (const output of Object.values(metafile.outputs)) return [...output.exports];

  return [];
}

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

/** One build per process, shared by both Vite configs and the bun preload. */
function slateVendorBundle(): SlateVendor {
  vendor ??= buildSlateVendor();

  return vendor;
}

/** A generated module with no imports; graph walks outside Vite must treat it that way too. */
export const SLATE_VENDOR_ID = 'virtual:kinu-slate-vendor';

const RESOLVED_ID = '\0virtual:kinu-slate-vendor';

/** Registered by vite.config.ts and vitest.config.ts so dev, build and the workerd pool resolve one id. */
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
