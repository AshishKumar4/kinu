/**
 * The `virtual:kinu-slate-vendor` module as the Vite plugin serves it — the
 * vendored react/capnweb byte strings the slate runner hands the dynamic
 * worker. The shape lives with the factory that builds it; an `import(...)`
 * type is the one relative form a `declare module` block accepts, so the two
 * cannot drift.
 */
declare module 'virtual:kinu-slate-vendor' {
  const vendor: import('../slate-vendor').SlateVendor;
  export default vendor;
}
