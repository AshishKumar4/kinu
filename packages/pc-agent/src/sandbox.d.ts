// The CLI imports this module's BYTES to install beside the daemon, never its
// API: the daemon requires it as a sibling at runtime. Declared here rather
// than as a wildcard pattern in the CLI, because TypeScript consults a pattern
// only where normal resolution finds nothing, and it finds sandbox.js.
declare const source: string;
export default source;
