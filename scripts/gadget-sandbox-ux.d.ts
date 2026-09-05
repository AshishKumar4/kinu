/**
 * The one Vite import suffix read through scripts/gadget-sandbox-ux.test.ts.
 *
 * That gate asserts the sandbox constants beside the document builder, whose
 * `capnweb?raw` import only vite understands, and this project typechecks
 * without vite/client. Declared here — the same two lines vite/client
 * carries — rather than by reaching for that whole package from the project
 * config. A `.d.ts` because an ambient wildcard declaration is global
 * script, which a module file cannot hold.
 */

declare module "*?raw" {
  const src: string;
  export default src;
}
