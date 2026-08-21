/**
 * The head journal, announcing itself.
 *
 * `head_activity` was never a property of the journal. On the Cloudflare backend
 * it was a side effect bolted onto two RPC methods — `recordHeadStep` on the
 * orchestrator and `headJournalRecordReport` on the actor — and both are
 * reachable only from a FACET calling back to its parent. The consequences,
 * measured:
 *
 *   - A top-level head's or node's COMPLETION never announced anything.
 *     `getHeadController` and the node host were handed the raw journal, whose
 *     `recordReport` has no broadcast anywhere in it, so an open transcript sat
 *     one write short of the answer it was waiting for — the exact defect
 *     `headJournalRecordReport`'s own comment says it fixed, fixed only for the
 *     recursive case that comment was written from.
 *   - An UNHOSTED node announced NOTHING, ever. `getCFNodeHost` answers
 *     undefined for a workspace with no owner, and core then wires `reportStep`
 *     straight to `journal.appendStep`. Its rows land correctly and a manual
 *     reload shows them, which is the worst shape a liveness defect can have.
 *   - A SPAWN announced nothing, so a node appearing in a running search was
 *     poll-only — and for `agents(action:'swarm')` that is the only channel
 *     there is, because `SwarmRunDeps` carries no progress seam at all.
 *
 * One seam instead of two call sites. Every path into the journal — hosted and
 * unhosted, head and node, top-level and recursive — goes through the instance a
 * backend hands the controller and the node host, so announcing HERE covers all
 * of them.
 *
 * SHARED, not cf-only: the listener is injected, and the CLI carries the same
 * defect in a stronger form — its nodes always run in process, so nothing it
 * journals has ever announced anything. It has a live surface to feed too, and a
 * copy of this class in each backend is the drift `gate:capability-parity`
 * exists to refuse.
 *
 * The announcement carries an id and never a row. Same reasoning as
 * `pending_actions_changed`: the reader re-reads the ledger it already renders
 * from, so one channel cannot start disagreeing with the other, and a
 * subscriber that missed a frame is corrected by the next one.
 */
import { diagnostics, toKinuError } from '../obs';
import type { SqlExecutor } from '../types/primitives';
import { HeadJournal } from './journal';
import type {
  Evidence, HeadId, HeadInput, HeadReport, HeadStep, MergeResult, MergeStrategy,
} from './types';

/** Told after a durable write lands, with the id whose ledger moved. */
export type AnnounceHeadActivity = (headId: HeadId) => void;

export class LiveHeadJournal extends HeadJournal {
  constructor(sql: SqlExecutor, private readonly listener: AnnounceHeadActivity) {
    super(sql);
  }

  /** The run itself, seeded. For a swarm this is the row that makes the search
   *  exist, so it is the first thing a watching client can learn. */
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

  /** The settle. Keyed to the ROOT, because what moved is the run. */
  override cacheMerge(rootId: HeadId, result: MergeResult, strategy: MergeStrategy): void {
    super.cacheMerge(rootId, result, strategy);
    this.announce(rootId);
  }

  /**
   * AFTER the write, and it cannot cost the write.
   *
   * The guard is HERE rather than in the listener, because that is where the
   * promise belongs: core calls these methods mid-search, and a socket with
   * nobody on it must never fail a journal write. Reported rather than
   * swallowed — a courtesy that stopped working is a finding, and a client that
   * silently stopped hearing about a running search is exactly the defect this
   * class was written for.
   */
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
