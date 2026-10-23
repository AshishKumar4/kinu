/** Vendored react/capnweb strings for the slate worker; `import(...)` is the one relative form `declare module` accepts. */
declare module 'virtual:kinu-slate-vendor' {
  const vendor: import('../slate-vendor').SlateVendor;
  export const workerCompatibility: typeof import('../vite-agent-bundle').workerCompatibility;
  export default vendor;
}

/** Each page module's file (by its name in `SLATE_PAGE_MODULES`) and the content-named file the app serves it as,
 *  written in by the build (`vite-slate-page-modules.ts`). */
declare const __KINU_SLATE_PAGE_MODULES__: Readonly<Record<string, string>>;
