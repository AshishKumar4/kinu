/**
 * The daemon as the CLI takes it: text.
 *
 * `packages/cli/src/device-connect.ts` imports this file with
 * `{ type: 'text' }` and writes the bytes to `~/.kinu/pc-agent.js`, so the
 * daemon ships inside the CLI release and `kinu connect` downloads nothing.
 * Bun inlines the bytes when `scripts/build-cli-dist.sh` bundles the CLI, and
 * reads this file when Bun runs the CLI from source.
 *
 * A declaration beside the file is what TypeScript resolves for a specifier
 * that names it: `index.js` is JavaScript, so without this the import is
 * TS7016. A wildcard ambient declaration in the importing package is not
 * equivalent — TypeScript consults a pattern only where normal resolution
 * finds nothing, and it finds this file.
 *
 * The daemon is a process, never a module a TypeScript file calls into: it is
 * dependency-free CommonJS that Bun runs, and its own suite requires it from
 * JavaScript. The one import of it, anywhere, is the text import above.
 */
declare const source: string;
export default source;
