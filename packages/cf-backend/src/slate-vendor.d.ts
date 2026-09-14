/**
 * The `virtual:kinu-slate-vendor` module as the Vite plugin serves it — the
 * vendored react/capnweb byte strings the slate runner hands the dynamic
 * worker. The shape lives here (not in `../slate-vendor.ts`) because a
 * `declare module` block may not import from a relative path; the factory
 * satisfies this interface so the two cannot drift.
 */
declare module 'virtual:kinu-slate-vendor' {
  export interface SlateVendor {
    readonly react: string;
    readonly reactStub: string;
    readonly capnweb: string;
    readonly capnwebWorkers: string;
    /** External specifiers each bundle still imports — from the metafile, so
     *  a test asserts the real edges, not a substring guess. */
    readonly imports: { readonly react: readonly string[]; readonly capnweb: readonly string[]; readonly capnwebWorkers: readonly string[] };
    /** The export names `react` publishes, parsed from the bundle's metafile:
     *  the stub and the test assert against the real set, not a hand list. */
    readonly reactExports: readonly string[];
  }

  const vendor: SlateVendor;
  export default vendor;
}
