import { createHash } from 'node:crypto';
import { buildSync, type Metafile } from 'esbuild';
import * as reactNs from 'react';
import * as v from 'valibot';
import type { Plugin } from 'vite';

const SpecifiersSchema = v.array(v.string());

/** Vendored bytes for dynamic workers: react/capnweb for the slate runner, puppeteer for `web.connectBrowser` and
 *  Nimbus's node-compat for `fs` and `child_process` in eval; `src/slate-vendor.d.ts` names this type. The bun test preload reads a built copy back from disk through
 *  the schema. */
export const SlateVendorSchema = v.object({
  /** Each file a page imports by name (`SLATE_PAGE_MODULES`), as served to it: React, capnweb, `kinu:slate`, uPlot
   *  (53 KB minified, 1.6.32), Preact with htm (12 KB, 10.28.4 and 3.1.1). */
  pageModules: v.record(v.string(), v.string()),
  /** `@cloudflare/puppeteer`, 296 KB minified (2026-09-28); `@cloudflare/playwright` measured 1.8 MB. */
  puppeteer: v.string(),
  /** `@nimbus-sh/core/node-compat`'s `createNodeCompat`, 48 KB minified (0.27.0, 2026-10-22); `node:*` stays the isolate's. */
  nodeCompat: v.string(),
  reactStub: v.string(),
  capnwebWorkers: v.string(),
  /** External specifiers per bundle, from the metafile. */
  imports: v.object({ react: SpecifiersSchema, capnweb: SpecifiersSchema, capnwebWorkers: SpecifiersSchema }),
  /** `react` export names, from the metafile. */
  reactExports: v.array(v.string()),
});

export type SlateVendor = v.InferOutput<typeof SlateVendorSchema>;

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
    // uPlot's stylesheet, carried in its module and added to the page that imports it.
    loader: { '.css': 'text' },
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
  const browser = ['browser', 'import'];
  // One Preact for every module that names it: hooks and htm import the page's own copy by its name.
  const preact = bundle('export * from "preact";', browser);
  const preactHooks = bundle('export * from "preact/hooks";', browser, ['preact']);
  const htmPreact = bundle('export * from "htm/preact";', browser, ['preact', 'preact/hooks']);

  const uplot = bundle([
    'import uPlot from "uplot";',
    'import css from "uplot/dist/uPlot.min.css";',
    'const style = document.createElement("style");',
    'style.textContent = css;',
    'document.head.append(style);',
    'export default uPlot;',
  ].join('\n'), browser);

  const capnwebWorkers = bundle('export * from "capnweb";', ['workerd', 'import'], ['cloudflare:*']);
  const puppeteer = bundle('export { default } from "@cloudflare/puppeteer";', ['workerd', 'worker', 'browser', 'import'], ['node:*', 'cloudflare:*']);
  const nodeCompat = bundle('export { createNodeCompat } from "@nimbus-sh/core/node-compat";', ['workerd', 'worker', 'import'], ['node:*']);

  // The libraries a page imports by name; `kinu:slate`'s own module (`slate.js`) is added by those that serve them, as
  // this file is read by plain Node too, where a relative TypeScript import does not resolve.
  const pageModules = {
    'react.js': react.text, 'capnweb.js': capnweb.text,
    'uplot.js': uplot.text, 'preact.js': preact.text, 'preact-hooks.js': preactHooks.text, 'htm-preact.js': htmPreact.text,
  };

  return {
    pageModules, puppeteer: puppeteer.text, nodeCompat: nodeCompat.text, reactStub, capnwebWorkers: capnwebWorkers.text, reactExports,
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

/** The page modules' files, `kinu:slate`'s own (`slate`) among them, each named for its content under
 *  `SLATE_PAGE_MODULES_PATH`: what the app serves a page the chat draws itself, and the file names it imports them by. */
export function slatePageFiles(slate: string): Record<string, { readonly name: string; readonly body: string }> {
  return Object.fromEntries(Object.entries({ ...slateVendorBundle().pageModules, 'slate.js': slate }).map(([file, body]) => [
    file, { name: `${file.replace(/\.js$/u, '')}-${createHash('sha256').update(body).digest('hex').slice(0, 8)}.js`, body },
  ]));
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
    load: async (id: string) => {
      if (id !== RESOLVED_ID) return null;

      const { workerCompatibility } = await import('./vite-agent-bundle');

      return `export const workerCompatibility = ${JSON.stringify(workerCompatibility)};\nexport default ${JSON.stringify(slateVendorBundle())};`;
    },
  };
}
