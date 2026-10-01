/** Vendored react/capnweb strings for the slate worker; `import(...)` is the one relative form `declare module` accepts. */
declare module 'virtual:kinu-slate-vendor' {
  const vendor: import('../slate-vendor').SlateVendor;
  export const workerCompatibility: typeof import('../vite-agent-bundle').workerCompatibility;
  export default vendor;
}
