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

export interface FenceReply {
  readonly id: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly cut: number;
  readonly generation: number;
  readonly manifestPath: string;
  readonly base: FenceBase;
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
}

export interface StopReply {
  readonly id: string;
  readonly ok: boolean;
  readonly sequence: number;
}

export interface Extent {
  readonly offset: number;
  readonly length: number;
  readonly sha256: string;
}

export interface SealedContent {
  readonly kind: 'sealed';
  readonly size: number;
  readonly sourceId: string;
  readonly extents: readonly Extent[];
}

export interface PosixMetadata {
  readonly uid: number;
  readonly gid: number;
  readonly atimeNs: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly xattrs: Readonly<Record<string, string>>;
}

export interface ManifestEntry {
  readonly path: string;
  readonly kind: 'file' | 'dir' | 'symlink';
  readonly mode: number;
  readonly ino: number;
  readonly target?: string;
  readonly metadata: PosixMetadata;
  readonly content?: SealedContent;
}

export interface Manifest {
  readonly cut: number;
  readonly generation: number;
  readonly stageRoot: string;
  readonly entries: readonly ManifestEntry[];
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
