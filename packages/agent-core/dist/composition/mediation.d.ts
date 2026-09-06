import type { ActorRef } from "../actors/index.js";
import { type LeaseToken, type RunInvocationDelivery, type TurnAdmissionHandle, type TurnInvocationPort, type TurnInvocationRequest } from "../agents/index.js";
import type { ContentStore } from "../content/index.js";
import { type Facet, type FacetManifest } from "../facets/index.js";
import type { TenantId } from "../identity/index.js";
import { InvocationPublicationDrainer, type AuthorityAdmissionPort, type CanonicalBatchAuthorityAuthenticationPort, type CanonicalBatchAuthorityPermitPort, type CanonicalBatchFinalAdmissionPort, type DetachedEffectExecutionPersistence, type DetachedEffectSweepReport, type ClaimWorkerId, type InvocationCommitPort, type InvocationEventPort, type InvocationEvidencePersistence, type InvocationReplayPersistence, type InvocationTransactionPort, type Receipt, type ReconciliationSchedulePort } from "../invocations/index.js";
import { MediatedAuthorityIntent, type OperationAuthorityStatePort } from "./authority.js";
import { type FacetActivationPinPort, type MediationAuthorityReference, type MediationDomainReference, type MediationLeaseReference, type MediationPathEpochReference, type MediationPersistence } from "./mediation-preparation.js";
/**
 * The caller identity the authority plane resolves Bindings for. A Turn presents its
 * exact live lease and nothing else, so a resolver can require the exact current token
 * (§7.2) without the gateway handing it any other capability.
 */
export interface MediatedTurnCaller {
    readonly token: LeaseToken;
}
export interface MediatedOperationPipelineInit<Transaction, Admission, Authentication, Denial = never> {
    /** The replay scope: one Actor's mediated request-key namespace (§7.3). */
    readonly scope: string;
    readonly actor: ActorRef;
    readonly tenant: TenantId;
    /**
     * The claim owner this worker incarnation is. Claim recovery requires a different
     * worker from the one whose claim expired, so a restarted worker presents a new one.
     */
    readonly worker: ClaimWorkerId;
    readonly transactions: InvocationTransactionPort<Transaction>;
    readonly persistence: MediationPersistence<Transaction, Admission>;
    /**
     * Where an item whose execution left its Turn is recorded (SPEC §5.6). It is its own store
     * because a host that detaches nothing needs no table for one, and because the record
     * carries neither a Lease nor an Admission to parameterize.
     */
    readonly detachedExecutions: DetachedEffectExecutionPersistence<Transaction>;
    /**
     * The detached driver's own durable schedule row. It is a second instance of the same
     * substrate contract the reconciliation driver uses and never the same row: two drivers
     * sharing one schedule would each clear the other's outstanding firing.
     */
    readonly detachedSchedule: ReconciliationSchedulePort;
    /** How long after a release the detached driver's next sweep is due. */
    readonly detachedIntervalMilliseconds: number;
    readonly evidence: InvocationEvidencePersistence<Transaction> & InvocationReplayPersistence<Transaction>;
    readonly authority: OperationAuthorityStatePort<MediatedTurnCaller>;
    /** The pinned manifests and Facet roots to activate; correspondence is validated. */
    readonly manifests: readonly FacetManifest[];
    readonly roots: readonly Facet[];
    readonly activations: FacetActivationPinPort;
    readonly permits: CanonicalBatchAuthorityPermitPort<Transaction, MediationLeaseReference, MediationAuthorityReference, MediationDomainReference, MediationPathEpochReference, Admission, Denial>;
    readonly authentication: CanonicalBatchAuthorityAuthenticationPort<MediationLeaseReference, MediationAuthorityReference, MediationDomainReference, MediationPathEpochReference, Admission, Authentication>;
    readonly admission: AuthorityAdmissionPort<Transaction, MediationLeaseReference, MediationAuthorityReference, MediationDomainReference, MediationPathEpochReference, Admission, Authentication>;
    readonly finalAdmission: CanonicalBatchFinalAdmissionPort<Transaction, MediatedAuthorityIntent, MediationLeaseReference, MediationAuthorityReference, MediationDomainReference, MediationPathEpochReference, Admission>;
    readonly content: ContentStore;
    readonly events: InvocationEventPort;
    readonly commits: InvocationCommitPort;
    readonly claimLifetimeMilliseconds: number;
    readonly now: () => Date;
}
/**
 * The composition root for SPEC §7 mediation.
 *
 * A consumer supplies the substrate — transactions, invocation and evidence persistence,
 * the authority state it resolves Bindings against, the activated Facet runtime, the
 * authority permit plane, and its target admission policy — and receives a
 * `TurnInvocationPort` it can hand straight to `TurnExecutorHost`, plus the publication
 * outbox that carries Receipt observations onward.
 *
 * It deliberately exposes none of its parts. `OperationGatewayHost` and
 * `FacetRuntimeHost` stay unexported because a consumer able to build a gateway by hand
 * is equally able to assemble one whose tiering, interception, replay, or evidence
 * wiring differs from the pipeline §7 describes, and nothing downstream would notice.
 * One narrow constructor keeps that assembly in a single place and still leaves every
 * genuine substrate decision with the consumer.
 *
 * The gateway and the invocation stack above it are built per Turn, because the Turn is
 * what owns the cancellation signal an Operation runs under. Nothing durable is
 * per-Turn: persistence, the ledger's ports, replay, and evidence are all shared, and
 * the only per-instance state is in-flight item deduplication, which is per Invocation
 * and therefore already per Turn — a mediated InvocationId commits the lease execution
 * identity, so two Turns never name the same one.
 *
 * Detached execution is the one part that is deliberately not per Turn (SPEC §5.6). An item
 * whose admission identity a Turn published outlives that Turn, so the target, the delivery
 * seam, and the driver are built once for the process and carry no Turn's signal: cancelling
 * such an item is the owning Run's message, never the issuing Turn's fence. Admission stays
 * per Turn, because the Turn's own cancellation is exactly what decides which side of the
 * §5.6 commit point an item falls on.
 */
export declare class MediatedOperationPipeline<Transaction, Admission, Authentication, Denial = never> implements AsyncDisposable {
    #private;
    readonly invocations: TurnInvocationPort;
    readonly outbox: InvocationPublicationDrainer<Transaction>;
    /**
     * Activates the pinned Facet runtime and assembles the pipeline around it. Activation
     * is the pipeline's because the gateway resolves Bindings against exactly the Facets
     * that correspondence validation admitted, and a half-activated runtime must never
     * become a mediation surface.
     */
    static activate<Transaction, Admission, Authentication, Denial = never>(init: MediatedOperationPipelineInit<Transaction, Admission, Authentication, Denial>): Promise<MediatedOperationPipeline<Transaction, Admission, Authentication, Denial>>;
    private constructor();
    /**
     * Admits one item of a Turn's mediated call and detaches its execution (SPEC §5.6).
     *
     * It is the same call `invoke` makes — the same gateway under the same Turn scope, the
     * same bound Operation check, the same authority, tiering and interception — stopped one
     * step earlier: the Invocation plane records the item's admission and runs nothing. That
     * is the fact §5.6's handle names and the fact a Receipt cannot state, which is why the
     * handle comes back from the admitted item rather than from Receipt evidence.
     *
     * An item refused before its effect answers with the pre-effect Receipt instead. Nothing
     * was detached in that case, so there is no handle to publish and no obligation for the
     * Run to take on.
     */
    admitDetached(request: TurnInvocationRequest): Promise<TurnDetachedAdmission>;
    /**
     * Accepts one durable message the Run owes this Invocation owner about a published item
     * (SPEC §5.6, §6.1).
     *
     * The Run's record carries the Run and the cause; neither crosses this seam. The Run is
     * the sender and says nothing about local state, and the cause is a request rather than a
     * verdict — so what travels is the exact item the message names, and this host re-reads
     * its own PreparedInvocation, item key, EffectAttempt and Receipt before it does anything.
     * A message naming state this host does not have raises `invocation.invalid`, which is the
     * signal to leave the Run's copy unacknowledged and redeliver.
     */
    accept(delivery: RunInvocationDelivery): Promise<void>;
    /**
     * Resumes detached execution from durable state, and reports when the next sweep is due.
     *
     * The HOST process owns restart. This pipeline holds no schedule of its own and revives
     * nothing on its own behalf: a host that has just started calls this once, and released
     * items whose sweep was lost to the restart are armed again from the records alone.
     *
     * The per-attempt AbortControllers are deliberately lost with the process. They are live
     * resources, and §8.3 keeps live resources off durable records, so there is nothing to
     * restore and nothing that pretends to be restored. That is exactly why a cancellation
     * arriving after a restart reports `absent`: no live effect was reached, so §7.4 leaves
     * the attempt `indeterminate` for reconciliation instead of recording an `aborted` failure
     * nobody observed.
     */
    resumeDetachedEffects(): Date | undefined;
    /**
     * One detached-effect alarm firing. The host owns the alarm — this pipeline holds no timer
     * — so a firing arrives here, executes the items the records say are released and
     * unfinished, and leaves the schedule armed exactly while any remain.
     */
    sweepDetachedEffects(): Promise<DetachedEffectSweepReport>;
    dispose(): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
}
/** What one Turn-issued detached admission became (SPEC §5.6). */
export type TurnDetachedAdmission = {
    readonly kind: "admitted";
    readonly handle: TurnAdmissionHandle;
} | {
    readonly kind: "terminal";
    readonly receipt: Receipt;
};
