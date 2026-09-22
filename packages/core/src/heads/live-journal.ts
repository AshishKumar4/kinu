/**
 * The head journal, announcing `head_activity` after each durable write. Every journal path (hosted
 * or not, head or node, any depth) goes through this instance. The announcement carries an id, never
 * a row: readers re-read the ledger.
 */
import { diagnostics, toKinuError } from '../obs';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { HeadJournal } from './journal';
import type {
  Evidence, HeadId, HeadInput, HeadReport, HeadStep, MergeResult, MergeStrategy,
} from './types';

/** Told after a durable write lands, with the id whose ledger moved. */
export type AnnounceHeadActivity = (headId: HeadId) => void;

export class LiveHeadJournal extends HeadJournal {
  constructor(sql: SqlExecutor, actor: ActorHandle, private readonly listener: AnnounceHeadActivity) {
    super(sql, actor);
  }

  /** For a swarm, the row that makes the search exist. */
  override recordSplit(rootId: HeadId, rationale: string, spawnedAt: number): void {
    super.recordSplit(rootId, rationale, spawnedAt);
    this.announce(rootId);
  }

  override insertSpawn(input: HeadInput): void {
    super.insertSpawn(input);
    this.announce(input.id);
  }

  override recordReport(report: HeadReport): void {
    super.recordReport(report);
    this.announce(report.id);
  }

  override appendStep(headId: HeadId, seq: number, step: HeadStep): void {
    super.appendStep(headId, seq, step);
    this.announce(headId);
  }

  override insertEvidence(headId: HeadId, ev: Evidence): void {
    super.insertEvidence(headId, ev);
    this.announce(headId);
  }

  /** Keyed to the root, because what moved is the run. */
  override cacheMerge(rootId: HeadId, result: MergeResult, strategy: MergeStrategy): void {
    super.cacheMerge(rootId, result, strategy);
    this.announce(rootId);
  }

  /** After the write, and it must never fail it: a listener failure is reported, not thrown. */
  private announce(headId: HeadId): void {
    try {
      this.listener(headId);
    } catch (err) {
      diagnostics.failure('head.activity_announce_failed', toKinuError({
        doing: 'announcing a head journal write to open clients',
        cause: err,
        otherwise: 'unavailable',
      }), { headId });
    }
  }
}
