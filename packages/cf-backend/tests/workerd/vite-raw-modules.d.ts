/**
 * Types the `?raw` suffix, so the Cap'n Web bundle import needs no suppression.
 *
 * `src/gadgets/host.ts` reads the bundle through `import('capnweb?raw')`, the
 * form Vite documents and the document builder already uses. This project's
 * tsconfig deliberately does not load `vite/client` (see the
 * `import.meta.env` note in tracing-fallback.test.ts), so the one slice this
 * project reads is declared here: a `?raw` answer is the file's text. Naming
 * `*?raw` keeps the missing-module error for every specifier the bundler does
 * not actually resolve.
 */
declare module '*?raw' {
  const bundle: string;
  export default bundle;
}
