import type { ContentStore } from "../content/index.js";
import type { EffectAttemptId } from "../invocation-references/index.js";
import { AttemptCancellationObservation, DetachedEffectTarget, type AdmittedInvocationItem, type CanonicalBatchItemExecution, type InvocationTransactionPort } from "../invocations/index.js";
import { FacetRuntimeHost } from "../operations/internal.js";
import type { MediationPersistence } from "./mediation-preparation.js";
/**
 * The mediation composition's live target for work a Turn detached (SPEC §5.6,
 * C13-TURN-HANDLE-DETACHMENT).
 *
 * A detached item outlives the Turn that issued it, so nothing here may hold a per-Turn
 * closure. `execution` rebuilds the live half of one admitted item from durable records
 * alone: the PreparedInvocation's pinned Operation resolved back against the Facet runtime
 * the composition activated, and the prepared arguments as stored. The Turn's authorization
 * is deliberately not rebuilt — §7.3 froze the whole intent at preparation and §7.4 admits
 * the attempt once, so a rebuilt authorization would be a second authority decision where
 * the rules require none, and a fabricated one at that.
 *
 * The controllers are the whole live resource this class owns, one per in-flight attempt and
 * keyed by `EffectAttemptId` because that is the one identity a Run's cancellation message
 * names. A restart empties the map by construction, which is why `cancel` answers `absent`
 * rather than pretending a controller nobody observed was aborted.
 */
export declare class DetachedMediationTarget<Transaction, Admission> extends DetachedEffectTarget {
    #private;
    private readonly facets;
    private readonly transactions;
    private readonly persistence;
    private readonly content;
    constructor(facets: FacetRuntimeHost, transactions: InvocationTransactionPort<Transaction>, persistence: MediationPersistence<Transaction, Admission>, content: ContentStore);
    /**
     * Rebuilds the execution of one admitted item, refusing rather than approximating.
     *
     * The pin is verified against the live runtime before anything runs: the pinned facet
     * target must still be the Facet this composition activated, the pinned operation name
     * must still be declared, and the live descriptor must still hash to the pinned digest.
     * The descriptor is the authority for §7.4's `outputInvalid`, so a live Facet whose
     * declaration has drifted from the pin is a refusal — the item's reconciliation owns what
     * happens next, not a descriptor the Invocation never admitted under.
     */
    execution(item: AdmittedInvocationItem): Promise<CanonicalBatchItemExecution>;
    /**
     * Aborts the one live controller this attempt runs under, or reports it absent.
     *
     * `absent` is the answer after a restart: no controller survived one, so no cancellation
     * reached an effect, and §7.4 leaves the outcome for reconciliation. Nothing here derives
     * `aborted` from the request — the running attempt a `reached` answer returns writes its
     * own Receipt through the ordinary classification path, because the signal it runs under
     * is the one just fired.
     */
    cancel(attempt: EffectAttemptId): Promise<AttemptCancellationObservation>;
    /** The controller one attempt runs under, created on first use and keyed by its attempt. */
    controller(attempt: EffectAttemptId): AbortController;
    /** Drops every live controller the way a process restart does, leaving the records. */
    restart(): void;
    private resolveOperation;
}
