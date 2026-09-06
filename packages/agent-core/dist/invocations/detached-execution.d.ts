import { Digest, RecordCodec, Revision } from "../core/index.js";
import { InvocationId } from "../interaction-references/index.js";
import { AdmittedInvocationItem } from "./admitted-item.js";
import { EffectAttemptId } from "./id.js";
declare const DETACHED_EXECUTION_STATES: readonly ["awaitingPublication", "released", "cancellationRequested"];
export type DetachedEffectExecutionStateKind = (typeof DETACHED_EXECUTION_STATES)[number];
/**
 * Where one detached item's execution stands: waiting for the Run to publish its admission
 * identity, released to run, or asked to stop (§5.6).
 *
 * Each case is a class carrying its own transitions, so a caller asks the state what happens
 * next instead of reading a label and deciding. Delivery from the Run is at-least-once and
 * unordered (§6.1), which is why every transition is idempotent and why a release after a
 * cancellation request stays cancelled: the Run has already ended, and the admission message
 * it wrote earlier says nothing that revives it. A transition that returns the same state is
 * how a duplicate becomes a no-op rather than a second effect.
 *
 * There is no terminal case. §7.4 answers "did this item finish" from its current Receipt,
 * and a second durable place to ask would be a state this record could hold while the Receipt
 * disagreed (§8.4).
 */
export declare abstract class DetachedEffectExecutionState {
    /** The item is admitted; the Run has not yet taken it into its own obligation. */
    static get awaitingPublication(): DetachedEffectExecutionState;
    /** The Run's admission message arrived; a driver may execute the item. */
    static get released(): DetachedEffectExecutionState;
    /** The Run asked for the item to stop; nothing releases it again. */
    static get cancellationRequested(): DetachedEffectExecutionState;
    abstract readonly kind: DetachedEffectExecutionStateKind;
    /** True for exactly the state whose item a driver may hand to the target. */
    abstract readonly executable: boolean;
    abstract release(): DetachedEffectExecutionState;
    abstract requestCancellation(): DetachedEffectExecutionState;
    equals(other: DetachedEffectExecutionState): boolean;
}
export interface DetachedEffectExecutionInit {
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly attempt: EffectAttemptId;
    readonly state: DetachedEffectExecutionState;
    readonly revision: Revision;
}
/**
 * The Invocation owner's durable record that one admitted item's execution left the Turn that
 * issued it (§5.6, C13-TURN-HANDLE-DETACHMENT).
 *
 * It exists because admission and execution are now separate: the EffectAttempt is durable
 * before the target runs, and nothing else on disk would say that the item is waiting for the
 * Run rather than running under a Turn. A per-Turn closure cannot carry that fact — the Turn
 * ends, the host restarts, and the closure is gone — so the fact is a record and the driver
 * rebuilds its work from it.
 *
 * It names the item and nothing more. The item key lives on the PreparedInvocation and the
 * ordinal on the EffectAttempt, so this record keeps neither: §8.4 forbids the second copy,
 * and every acceptance re-reads those owners anyway to decide whether a message is exact.
 */
export declare class DetachedEffectExecution {
    static get codec(): RecordCodec<DetachedEffectExecution>;
    readonly id: Digest;
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly attempt: EffectAttemptId;
    readonly state: DetachedEffectExecutionState;
    readonly revision: Revision;
    /** The first state of a freshly admitted detached item. */
    static awaiting(candidate: AdmittedInvocationItem): DetachedEffectExecution;
    static encode(record: DetachedEffectExecution): Uint8Array;
    static decode(bytes: Uint8Array): DetachedEffectExecution;
    constructor(init: DetachedEffectExecutionInit);
    released(): DetachedEffectExecution;
    cancellationRequested(): DetachedEffectExecution;
    /** True when `this` is exactly the next stored revision after `current`. */
    follows(current: DetachedEffectExecution): boolean;
    private transition;
}
export declare const DetachedEffectExecutionCodec: RecordCodec<DetachedEffectExecution>;
/**
 * The Invocation-owned store of detached execution records. It is its own seam rather than
 * more methods on `InvocationPersistence` because a host that never detaches an item needs no
 * table for one, and the record has no Lease or Admission parameter to carry.
 */
export interface DetachedEffectExecutionPersistence<Transaction> {
    detachedExecution(transaction: Transaction, attempt: EffectAttemptId): DetachedEffectExecution | undefined;
    /** Every released record in one canonical order, newest last, bounded by `limit`. */
    releasedDetachedExecutions(transaction: Transaction, limit: number): readonly DetachedEffectExecution[];
    appendDetachedExecution(transaction: Transaction, record: DetachedEffectExecution): void;
}
export {};
