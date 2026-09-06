import type { InvocationId } from "../interaction-references/index.js";
import { AdmittedInvocationItem } from "./admitted-item.js";
import type { CanonicalBatchItemExecution, CanonicalBatchItemResult, CanonicalBatchRecordPort } from "./canonical-batch.js";
import type { DetachedEffectExecutionPersistence } from "./detached-execution.js";
import type { DetachedEffectTarget } from "./detached-target.js";
import type { EffectAttemptId } from "./id.js";
import type { InvocationLedger } from "./ledger.js";
import type { InvocationPersistence } from "./persistence.js";
import type { InvocationEvidencePersistence, InvocationTransactionPort } from "./ports.js";
import type { AttemptReceipt, Receipt } from "./receipt.js";
/**
 * What one Run admission message left behind.
 *
 * Every case means the message is discharged and may be acknowledged; a message that does not
 * name this host's exact state is refused by throwing instead, because acknowledging it would
 * discard the Run's only copy of a command nobody executed. `executable` is the one bit a
 * caller acts on: it says a driver now has work that did not exist before.
 */
export declare abstract class DetachedEffectAdmissionOutcome {
    /** This message released the item; a driver must be armed. */
    static get released(): DetachedEffectAdmissionOutcome;
    /** A duplicate of a message already applied; nothing changed. */
    static get alreadyReleased(): DetachedEffectAdmissionOutcome;
    /** The Run's cancellation reached this item first, so nothing releases it. */
    static get cancellationRequested(): DetachedEffectAdmissionOutcome;
    /** The item already has a current Receipt; there is nothing left to release. */
    static settled(receipt: Receipt): DetachedEffectAdmissionOutcome;
    abstract readonly kind: "released" | "alreadyReleased" | "cancellationRequested" | "settled";
    /** True exactly when this message left work for a driver to execute. */
    abstract readonly executable: boolean;
    /** The Receipt that already ended the item, when one did. */
    abstract readonly receipt: Receipt | undefined;
}
/**
 * What one Run cancellation message reached.
 *
 * `reached` records nothing: the live effect ends through the ordinary path and its own
 * classification names §7.4's `aborted`. `recorded` carries the `indeterminate` Receipt this
 * host wrote because no live effect remained to abort, which is the honest outcome for an
 * admitted attempt nobody observed and the one reconciliation resolves. `settled` is a
 * redelivery for an item that already finished.
 */
export declare abstract class DetachedEffectCancellationOutcome {
    static get reached(): DetachedEffectCancellationOutcome;
    static recorded(receipt: AttemptReceipt): DetachedEffectCancellationOutcome;
    static settled(receipt: Receipt): DetachedEffectCancellationOutcome;
    abstract readonly kind: "reached" | "recorded" | "settled";
    abstract readonly receipt: Receipt | undefined;
}
/** The one execution step this port drives; the batch port satisfies it. */
interface AdmittedItemExecutor {
    executeAdmittedItem(item: AdmittedInvocationItem, execution: CanonicalBatchItemExecution): Promise<CanonicalBatchItemResult>;
}
/**
 * The Invocation owner's inbound seam for the Run's messages about one detached item
 * (SPEC §5.6, §6.1), and the execution step a driver drives.
 *
 * It takes scalar facts rather than the Run's record: delivery is at-least-once across an
 * Actor boundary with no shared transaction, so the Invocation owner accepts nothing on the
 * sender's word. Every entry point re-reads its own state — the PreparedInvocation, that
 * item's key, the latest EffectAttempt, and the current Receipt — and a message that does not
 * name exactly that state is refused with a typed error rather than acknowledged.
 *
 * A cancellation is a request, never a verdict. This port asks the target to abort the exact
 * attempt and records only what the target observed, so §7.4's `aborted` still comes from the
 * cancellation that reached the effect and never from the fact that a Run asked.
 */
export declare class DetachedEffectDeliveryPort<Transaction, Lease, Authority, Domain, PathEpochs, Admission, Authentication = undefined> {
    private readonly transactions;
    private readonly persistence;
    private readonly detachedExecutions;
    private readonly ledger;
    private readonly records;
    private readonly evidence;
    private readonly target;
    private readonly executor;
    private readonly now;
    constructor(transactions: InvocationTransactionPort<Transaction>, persistence: InvocationPersistence<Transaction, Lease, Authority, Domain, PathEpochs, Admission>, detachedExecutions: DetachedEffectExecutionPersistence<Transaction>, ledger: InvocationLedger<Transaction, Lease, Authority, Domain, PathEpochs, Admission, Authentication>, records: CanonicalBatchRecordPort<Lease, Authority, Domain, PathEpochs, Admission>, evidence: InvocationEvidencePersistence<Transaction>, target: DetachedEffectTarget, executor: AdmittedItemExecutor, now: () => Date);
    /**
     * Accepts the Run's admission message: the Run took the published item into its own
     * obligation, so the item may run. Releasing is idempotent, and a duplicate changes nothing
     * rather than starting a second effect.
     */
    release(invocation: InvocationId, itemIndex: number, itemKey: string, attempt: EffectAttemptId): DetachedEffectAdmissionOutcome;
    /**
     * Accepts the Run's cancellation message: the Run ended while this item was still owed, so
     * the target is asked to stop the exact attempt.
     *
     * The durable request is recorded first and the target is asked after that transaction
     * commits. There is no cross-Actor transaction to join, and a request that survives only in
     * memory would be lost by exactly the restart that also loses the live effect.
     */
    cancel(invocation: InvocationId, itemIndex: number, itemKey: string, attempt: EffectAttemptId): Promise<DetachedEffectCancellationOutcome>;
    /**
     * Runs one released item. The target rebuilds the live request from durable records, so the
     * same call serves the host that admitted the item and a host that restarted since.
     */
    execute(item: AdmittedInvocationItem): Promise<CanonicalBatchItemResult>;
    /**
     * Writes down what the target observed, once its answer is in hand. An `absent` observation
     * carries `indeterminate` and nothing else can be honestly recorded: no live effect was
     * reached, so no cancellation reached the attempt, and §7.4 leaves the outcome unknown for
     * reconciliation to resolve.
     */
    private record;
    private receipt;
    /**
     * The exact-state read every message is judged against. It refuses rather than reporting,
     * because each condition it checks means the message names work this host does not have:
     * an Invocation it never prepared, an item whose key does not match, an attempt that is not
     * the item's latest, or an item that was never detached in the first place.
     */
    private state;
}
export {};
