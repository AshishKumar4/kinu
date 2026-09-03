/**
 * The contract between the in-container journal daemon matrix and the host test
 * that asserts on its report. Types only: the matrix runs with nothing but Bun
 * available, so this module must stay free of runtime code.
 */

export interface Check {
  readonly check: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** One line of probe output: a verified check, a progress event, or a summary. */
export interface ProbeLine {
  readonly check?: string;
  readonly ok?: boolean;
  readonly detail?: string;
  readonly event?: string;
  readonly round?: number;
  readonly ms?: number;
  readonly failures?: number;
  readonly mode?: string;
  readonly checks?: number;
  readonly failed?: number;
}

export interface ProbeEvent {
  readonly event: string;
  readonly round: number;
  readonly ms: number;
  readonly failures: number;
}

export interface FenceBase {
  readonly cut: string;
  readonly generation: string;
  readonly root: string;
}

/** What one seal cost, in the field names the durability contract declares.
 *  The daemon fills the two it owns; the rest belong to the sidecar's build. */
export interface SealWork {
  readonly bytesStaged: number;
  readonly bytesChunked: number;
  readonly chunksHashed: number;
  readonly nodesRewritten: number;
  readonly wholeFiles: number;
}

export interface FenceReply {
  readonly id: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly cut: number;
  readonly generation: number;
  readonly manifestPath: string;
  readonly base: FenceBase;
  readonly sealWork: SealWork;
}

/** The reply to the post-CAS boundary hand-back. */
export interface BoundariesReply {
  readonly id: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly boundaryFiles?: number;
}

export interface StatsReply {
  readonly id: string;
  readonly ok: boolean;
  readonly sequence: number;
  readonly generation: number;
  readonly active: number;
  readonly admitted: boolean;
  readonly records: number;
  readonly batches: number;
  readonly journalBytes: number;
  readonly directIoAllowMmap: boolean;
  /** Whether the kernel accepted read passthrough for this session. */
  readonly passthrough: boolean;
  /** Writes served, journal bytes appended, and the two sync counts that
   *  separate what the WAL costs from what a caller's fsync costs. */
  readonly writes: number;
  readonly walBytes: number;
  readonly walFsyncs: number;
  readonly backingFsyncs: number;
  /** Files whose published chunk boundaries the daemon currently holds. */
  readonly boundaryFiles: number;
}

export interface StopReply {
  readonly id: string;
  readonly ok: boolean;
  readonly sequence: number;
}

/** One staged run: bytes the stage holds at this exact file offset, with the
 *  digest of what was copied. */
export interface Extent {
  readonly offset: number;
  readonly length: number;
  readonly sha256: string;
}

/** One written run: where a re-chunk has to begin.  Deliberately separate from
 *  {@link Extent}: the stage holds more than the writes touched, because a
 *  cluster grows to its previous chunk boundaries. */
export interface DirtyRange {
  readonly offset: number;
  readonly length: number;
}

/**
 * One path the delta describes, as it stands at the cut: full POSIX identity
 * for every kind, plus the written and staged runs for a file.
 */
export interface DeltaEntry {
  readonly path: string;
  readonly kind: 'file' | 'dir' | 'symlink';
  /** Decimal: an inode number does not fit a JSON number on every host. */
  readonly ino: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly atimeNs: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly xattrs: Readonly<Record<string, string>>;
  readonly target?: string;
  readonly size?: number;
  readonly whole?: boolean;
  readonly dirty?: readonly DirtyRange[];
  readonly ranges?: readonly Extent[];
}

/** One metadata operation to replay, in journal order. */
export interface MetadataOp {
  readonly sequence: number;
  readonly op: string;
  readonly path: string;
  readonly argument: string;
  readonly result: number;
}

/**
 * The delta manifest a fence writes: the paths the journal shows changed since
 * the previous fence and their ancestors, the operations that changed them, and
 * the staged bytes of the dirty clusters.  It is not a whole tree, which is the
 * point: a seal costs O(k) instead of O(n).
 */
export interface DeltaManifest {
  readonly version: 2;
  readonly cut: number;
  readonly generation: number;
  readonly stageRoot: string;
  readonly base: FenceBase | null;
  readonly entries: readonly DeltaEntry[];
  readonly metadataOps: readonly MetadataOp[];
  readonly sealWork: SealWork;
}

export interface JournalRecord {
  readonly sequence: number;
  readonly kind: string;
  readonly op: string;
  readonly outcome: number;
  readonly generation: number;
  readonly path: string;
  readonly aux: string;
}

export interface FenceFacts {
  readonly cut: number;
  readonly generation: number;
  readonly entries: number;
  readonly files?: number;
  readonly extents?: number;
  readonly stagedBytes?: number;
  readonly ops?: number;
  readonly wholeFiles?: number;
}

/** What one fence cost against one tree size, for the ratio the O(k) cell runs. */
export interface DeltaCostFacts {
  readonly treeBytes: number;
  readonly treeFiles: number;
  readonly dirtyBytes: number;
  readonly bytesStaged: number;
  readonly entries: number;
  readonly stagedFiles: number;
  readonly fenceMs: number;
}

export interface RoundFacts {
  readonly before: number;
  readonly during: number;
  readonly after: number;
  readonly total: number;
}

export interface CommitFacts {
  readonly records: number;
  readonly batches: number;
}

export interface ExitFacts {
  readonly code: number;
  readonly ms: number;
  readonly unmounted: boolean;
}

export interface ExportedFence {
  readonly cut: number;
  readonly generation: number;
  readonly manifestPath: string;
  readonly base: FenceBase;
  readonly sealWork: SealWork;
}

/** Everything a scenario chooses to publish, per scenario, in one shape. */
export interface MatrixFacts {
  firstFence?: FenceFacts;
  secondFence?: FenceFacts;
  recoveredFence?: FenceFacts;
  killedAfter?: FenceFacts;
  nextFence?: FenceFacts;
  exportedFence?: ExportedFence;
  seededBase?: { readonly started: number; readonly advanced: number; readonly equal: number };
  mmapRounds?: RoundFacts;
  groupCommit?: CommitFacts;
  manifestBytes?: number;
  attempts?: number;
  tornIntents?: number;
  durableResults?: number;
  journalBytesBefore?: number;
  journalBytesAfter?: number;
  /** The write path's own counters, and the fence rows the O(k) cell compares. */
  writePath?: { readonly writes: number; readonly walFsyncs: number; readonly backingFsyncs: number };
  fsyncPath?: { readonly fsyncs: number; readonly backingFsyncs: number; readonly walFsyncs: number };
  restartDirty?: { readonly written: number; readonly recovered: number; readonly ranges: number };
  rangeUnion?: readonly DirtyRange[];
  metadataOrder?: readonly string[];
  smallTree?: DeltaCostFacts;
  largeTree?: DeltaCostFacts;
  enospc?: { readonly errno: string; readonly recordsWithoutEffect: number; readonly effectsWithoutRecord: number };
  reads?: { readonly passthrough: boolean; readonly bytes: number };
  sigterm?: ExitFacts;
  stop?: ExitFacts;
  /** One exit per shutdown entry replayed against the race-detecting build. */
  racedShutdowns?: Record<string, ExitFacts>;
}

export interface ScenarioReport {
  readonly name: string;
  readonly ok: boolean;
  readonly facts: MatrixFacts;
  readonly checks: readonly Check[];
  readonly error?: string;
}

export interface MatrixReport {
  readonly ok: boolean;
  readonly scenarios: readonly ScenarioReport[];
}
