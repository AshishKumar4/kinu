import type { ContentStore } from "../content/index.js";
import type { FacetData, OperationContext, OperationDescriptor } from "../facets/index.js";
import type { AdmittedInvocationItem } from "./admitted-item.js";
import type { CanonicalBatchItemExecution, CanonicalBatchTargetAdmission } from "./canonical-batch.js";
import { EffectAttemptId } from "./id.js";
import { AttemptCompletion, type AttemptTargetDomain } from "./receipt.js";
/**
 * What the target observed when it was asked to stop one exact attempt.
 *
 * This is an observation and never a verdict. §7.4 lets a host record `aborted` only for
 * cancellation that reached the attempt, and the party that knows whether it reached one is
 * the target holding the live effect — not the Run that asked and not this value. So the two
 * cases carry the consequence for the Invocation owner rather than a failure kind, and there
 * is no member from which `AttemptFailureKind.aborted` can be built:
 *
 * - `reached`: the target aborted the exact live effect. The running attempt ends through the
 *   ordinary path, and its own classification names `aborted` because the signal it runs under
 *   is the one that fired. Nothing is recorded here.
 * - `absent`: the target holds no live effect for this attempt — the usual case after a
 *   restart. The attempt was admitted and its outcome is unknown, which §7.4 already fixes as
 *   `indeterminate`, so reconciliation resolves it. Manufacturing `aborted` here would claim a
 *   fact about a controller nobody observed.
 */
export declare abstract class AttemptCancellationObservation {
    /** The target aborted the exact live effect this attempt runs. */
    static get reached(): AttemptCancellationObservation;
    /** The target holds no live effect for this attempt. */
    static get absent(): AttemptCancellationObservation;
    abstract readonly kind: "reached" | "absent";
    /**
     * The completion the Invocation owner records itself, or `undefined` when the live effect
     * ends the attempt and writes its own Receipt.
     */
    abstract readonly completion: AttemptCompletion | undefined;
    equals(other: AttemptCancellationObservation): boolean;
}
/**
 * The live target of a detached item: it starts the work and it can stop it.
 *
 * Both members are on one contract because they name one live resource from two directions.
 * The signal in the resources it returns is the same cancellation `cancel` fires, which is
 * what makes "cancellation reached the attempt" true rather than advisory (§4.3's reachability
 * requirement). An implementation that returned an unrelated signal would leave every reached
 * cancellation classified as `indeterminate`.
 *
 * `execution` carries only what the execution step reads — the pinned Operation's declared
 * shape and its handler — and never a whole `MediatedInvocationRequest`. A detached item
 * outlives the Turn that issued it, so a per-Turn closure is exactly what this contract
 * replaces: after a restart the durable records are all there is, and the parts of a live
 * request that are not reconstructible (its request key, its full authority intent, its
 * interceptor traces) must not be demanded here, because a target could satisfy that demand
 * only by fabricating authority evidence. An implementation that cannot rebuild the handler
 * refuses rather than returning one that runs a different effect.
 */
export declare abstract class DetachedEffectTarget {
    abstract execution(item: AdmittedInvocationItem): Promise<CanonicalBatchItemExecution>;
    abstract cancel(attempt: EffectAttemptId): Promise<AttemptCancellationObservation>;
}
export interface MemoryDetachedEffectTargetInit {
    /** The pinned Operation's declared shape, as the host resolves it from durable records. */
    readonly descriptor: OperationDescriptor;
    /**
     * The live handler for one admitted item, as a host would resolve it. It receives the item's
     * index and the same OperationContext every execution builds, so a target resolves the
     * per-item closure once rather than once per call site.
     */
    execute(item: AdmittedInvocationItem, itemIndex: number, context: OperationContext): Promise<FacetData> | FacetData;
    readonly content: ContentStore;
    readonly deadline?: Date;
    readonly target?: AttemptTargetDomain;
    readonly targetAdmission?: CanonicalBatchTargetAdmission;
}
/**
 * The in-memory reference target: one live controller per in-flight attempt, keyed by
 * EffectAttemptId, and a `restart` that drops every one of them the way a host restart does.
 */
export declare class MemoryDetachedEffectTarget extends DetachedEffectTarget {
    #private;
    private readonly init;
    constructor(init: MemoryDetachedEffectTargetInit);
    /** The controller this target hands to one attempt, created on first use. */
    controller(attempt: EffectAttemptId): AbortController;
    /** Drops every live controller, leaving only the durable records behind. */
    restart(): void;
    execution(item: AdmittedInvocationItem): Promise<CanonicalBatchItemExecution>;
    cancel(attempt: EffectAttemptId): Promise<AttemptCancellationObservation>;
}
