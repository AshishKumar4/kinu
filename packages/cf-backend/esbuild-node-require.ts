/** `require()` of a Node built-in from a CommonJS dependency, bundled by esbuild for workerd. */
import { builtinModules } from 'node:module';
import type { Plugin } from 'esbuild';

// esbuild's filters are Go regular expressions; no built-in's name holds a character special to one.
const BUILTIN = new RegExp(`^(node:)?(${builtinModules.filter((name) => !name.startsWith('node:')).join('|')})$`);

/**
 * A CommonJS module's `require('url')` as an ESM import of `node:url`, which nodejs_compat serves. esbuild otherwise
 * leaves a `require` call that workerd has no `require` for, and the module throws "Dynamic require of "node:url" is not
 * supported" when it first loads. Nimbus core 0.16's npm (npm-package-arg, nopt, @npmcli/config) is the first such
 * dependency in Kinu's isolates; wrangler and the Vite plugin rewrite these requires the same way for the Worker itself.
 */
export const nodeRequireAsImport: Plugin = {
  name: 'kinu:node-require-as-import',
  setup(build) {
    build.onResolve({ filter: BUILTIN }, (args) => (args.kind === 'require-call'
      ? { path: args.path.startsWith('node:') ? args.path : `node:${args.path}`, namespace: 'kinu-node-require' }
      : undefined));
    build.onLoad({ filter: /.*/, namespace: 'kinu-node-require' }, (args) => ({
      contents: `import * as builtin from ${JSON.stringify(args.path)};\nmodule.exports = 'default' in builtin ? builtin.default : builtin;\n`,
      loader: 'js',
    }));
  },
};
