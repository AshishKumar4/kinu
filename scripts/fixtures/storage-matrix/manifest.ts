interface MatrixCase<Id extends string> {
  readonly id: Id;
  readonly purpose: string;
}

export const STORAGE_TREE_CASES = [
  { id: 'T0', purpose: 'Empty workspace.' },
  { id: 'T1', purpose: 'Small best-case workspace.' },
  { id: 'T2', purpose: 'Representative source, package, Git, and SQLite workspace.' },
  { id: 'T3', purpose: 'Wide tree and large-directory limit.' },
  { id: 'T4', purpose: 'Deep paths and metadata boundary cases.' },
  { id: 'T5', purpose: 'Measured disk-pressure condition.' },
] as const satisfies readonly MatrixCase<string>[];

export const STORAGE_CHANGE_CASES = [
  { id: 'C0', purpose: 'No change.' },
  { id: 'C1', purpose: 'One 4 KiB overwrite.' },
  { id: 'C2', purpose: 'Twenty small overwrites across directories.' },
  { id: 'C3', purpose: 'One 64 MiB append.' },
  { id: 'C4', purpose: 'SQLite page rewrites and WAL checkpoint.' },
  { id: 'C5', purpose: 'File and directory renames.' },
  { id: 'C6', purpose: 'Large subtree deletion and partial recreation.' },
  { id: 'C7', purpose: 'Metadata, link, and empty-directory changes.' },
  { id: 'C8', purpose: 'Large byte rewrite over few paths.' },
  { id: 'C9', purpose: 'Full workspace replacement.' },
  { id: 'C10', purpose: 'Concurrent mutation across the capture cut.' },
] as const satisfies readonly MatrixCase<string>[];

export const STORAGE_CACHE_CASES = [
  { id: 'K0', purpose: 'Fresh container with cold caches.' },
  { id: 'K1', purpose: 'Warm cache after a complete walk.' },
  { id: 'K2', purpose: 'Measured half-warm working set.' },
  { id: 'K3', purpose: 'Cache and native-disk pressure.' },
] as const satisfies readonly MatrixCase<string>[];

export const STORAGE_FAULTS = [
  { id: 'F0', purpose: 'Capture interruption.' },
  { id: 'F1', purpose: 'Payload interruption.' },
  { id: 'F2', purpose: 'Multipart interruption.' },
  { id: 'F3', purpose: 'Index interruption.' },
  { id: 'F4', purpose: 'Root before head.' },
  { id: 'F5', purpose: 'Head transaction or reply interruption.' },
  { id: 'F6', purpose: 'DO reset at every external await.' },
  { id: 'F7', purpose: 'Stale writer epoch.' },
  { id: 'F8', purpose: 'Rollback or wrong parent.' },
  { id: 'F9', purpose: 'Missing or corrupt object.' },
  { id: 'F10', purpose: 'Hostile metadata.' },
  { id: 'F11', purpose: 'Capability escape or replay.' },
  { id: 'F12', purpose: 'Credential exposure.' },
  { id: 'F13', purpose: 'Pin and GC race.' },
  { id: 'F14', purpose: 'Platform or resource failure.' },
  { id: 'F15', purpose: 'Teardown interruption.' },
] as const satisfies readonly MatrixCase<string>[];

export const STORAGE_GATES = [
  { id: 'G0', purpose: 'Provenance.' },
  { id: 'G1', purpose: 'Mount truth.' },
  { id: 'G2', purpose: 'Filesystem semantics.' },
  { id: 'G3', purpose: 'Publication safety.' },
  { id: 'G4', purpose: 'Security.' },
  { id: 'G5', purpose: 'Restore complexity.' },
  { id: 'G6', purpose: 'Complete cells.' },
  { id: 'G7', purpose: 'Reconciled accounting.' },
  { id: 'G8', purpose: 'Complete cleanup.' },
  { id: 'G9', purpose: 'Statistical validity.' },
] as const satisfies readonly MatrixCase<string>[];

export const STORAGE_CLEANUP_GATES = [
  { id: 'C1', purpose: 'Worker absent.' },
  { id: 'C2', purpose: 'Container resources absent.' },
  { id: 'C3', purpose: 'Bucket and multipart state empty.' },
  { id: 'C4', purpose: 'Box durable state empty.' },
  { id: 'C5', purpose: 'Local credentials and processes absent.' },
  { id: 'C6', purpose: 'Operation counters reconciled.' },
  { id: 'C7', purpose: 'Cleanup replay is idempotent.' },
] as const satisfies readonly MatrixCase<string>[];

export const STORAGE_STAGES = [
  { id: 'platform', purpose: 'Transport, capture, FUSE, cleanup, and instrumentation preflight.', trees: [], changes: [], caches: [] },
  { id: 'blank', purpose: 'Blank-disk truth.', trees: ['T0'], changes: ['C0'], caches: ['K0'] },
  { id: 'best', purpose: 'Best-case semantics and latency.', trees: ['T1'], changes: ['C0', 'C1', 'C2', 'C3', 'C5', 'C6', 'C7', 'C10'], caches: ['K0', 'K1'] },
  { id: 'representative', purpose: 'Representative ranking evidence.', trees: ['T2'], changes: ['C2', 'C3', 'C4', 'C5', 'C7', 'C8', 'C10'], caches: ['K0', 'K1', 'K2', 'K3'] },
  { id: 'adversarial', purpose: 'Wide, deep, pressure, security, and GC limits.', trees: ['T3', 'T4', 'T5'], changes: ['C1', 'C5', 'C6', 'C7', 'C8'], caches: ['K0', 'K3'] },
  { id: 'scaling', purpose: 'Restore and history complexity.', trees: [], changes: [], caches: [], scales: { pending: [0, 1, 16, 256, 4096, 4097], history: [1, 100, 10_000] } },
  { id: 'confirmatory', purpose: 'Preregistered differentiating cells only.', trees: [], changes: [], caches: [] },
] as const;
