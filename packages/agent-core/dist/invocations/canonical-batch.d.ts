import type { ContentStore } from "../content/index.js";
import { type ContentRef } from "../core/index.js";
import { type FacetData, type OperationContext, type OperationDescriptor } from "../facets/index.js";
import { type MediatedInvocationRequest } from "../operations/index.js";
import type { InvocationId } from "../interaction-references/index.js";
import { AdmittedInvocationItem } from "./admitted-item.js";
import type { EffectAttempt } from "./attempt.js";
import type { AuditRecord } from "./audit.js";
import type { ItemClaim } from "./claim.js";
import { type DetachedEffectExecutionPersistence } from "./detached-execution.js";
import type { InvocationLedger } from "./ledger.js";
import type { InvocationPersistence } from "./persistence.js";
import { type AuthorityAdmissionReference, type InvocationEvidencePersistence, type InvocationTransactionPort } from "./ports.js";
import type { PreparedInvocation } from "./prepared.js";
import type { InvocationReconciliationRecordPort } from "./reconciliation.js";
import { AttemptCompletion, AttemptReceipt, PreEffectReceipt, type AttemptTargetDomain, type PreEffectReceiptOutcome, type Receipt } from "./receipt.js";
export interface CanonicalBatchInvocationRequest<Authorization> {
    readonly invocation: InvocationId;
    readonly request: MediatedInvocationRequest<Authorization>;
}
export type CanonicalBatchItemResult = {
    readonly kind: "succeeded";
    readonly itemIndex: number;
    readonly receipt: AttemptReceipt;
    readonly output: FacetData;
} | {
    readonly kind: "terminal";
    readonly itemIndex: number;
    readonly receipt: Receipt;
};
export interface CanonicalBatchInvocationResult {
    readonly invocation: InvocationId;
    readonly items: readonly CanonicalBatchItemResult[];
}
export interface CanonicalBatchInvoker<Authorization> {
    invoke(request: CanonicalBatchInvocationRequest<Authorization>): Promise<CanonicalBatchInvocationResult>;
}
export interface CanonicalBatchPreparationPort<Authorization, Lease, Authority, Domain, PathEpochs> {
    prepare(request: CanonicalBatchInvocationRequest<Authorization>): PreparedInvocation<Lease, Authority, Domain, PathEpochs>;
}
export interface CanonicalBatchAuthorityPermitPort<Transaction, Lease, Authority, Domain, PathEpochs, Admission, Denial = never> {
    issue(invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>, claim: ItemClaim<Lease>): Promise<CanonicalBatchAuthorityPermitResult<Admission, Denial>>;
    deny(transaction: Transaction, invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>, claim: ItemClaim<Lease>, denial: Denial): void;
}
export type CanonicalBatchAuthorityPermitResult<Admission, Denial = never> = {
    readonly kind: "issued";
    readonly admission: AuthorityAdmissionReference<Admission>;
} | {
    readonly kind: "denied";
    readonly denial: Denial;
    readonly reason: string;
} | {
    readonly kind: "invalid";
    readonly reason: string;
} | {
    readonly kind: "expired";
};
export interface CanonicalBatchAuthorityAuthenticationPort<Lease, Authority, Domain, PathEpochs, Admission, Authentication> {
    authenticate(invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>, claim: ItemClaim<Lease>, admission: AuthorityAdmissionReference<Admission>): Promise<Authentication>;
}
export interface CanonicalBatchRecordPort<Lease, Authority, Domain, PathEpochs, Admission> extends InvocationReconciliationRecordPort<Lease, Authority, Domain, PathEpochs, Admission> {
    invocationAudit(invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>): AuditRecord;
    claim(invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>, itemIndex: number, previous: ItemClaim<Lease> | undefined, now: Date): ItemClaim<Lease>;
    retryClaim(invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>, previous: EffectAttempt<Lease, Admission>, now: Date): ItemClaim<Lease>;
    attempt(invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>, claim: ItemClaim<Lease>, admission: AuthorityAdmissionReference<Admission>, now: Date): EffectAttempt<Lease, Admission>;
    attemptAudit(invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>, attempt: EffectAttempt<Lease, Admission>): AuditRecord;
    /**
     * The outcome is an argument because §7.4 gives the pre-effect variant two of them and
     * they are different facts: a denial before the effect and a cancellation before the
     * effect derive different batch outcomes (§7.5) and carry different ids (§7.4's one
     * owning-Actor namespace). A port that chose the outcome itself would answer a question
     * only the admission point can answer.
     */
    preEffectReceipt(invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>, claim: ItemClaim<Lease>, outcome: PreEffectReceiptOutcome, recordedAt: Date, reason: string): PreEffectReceipt;
    attemptReceipt(attempt: EffectAttempt<Lease, Admission>, completion: AttemptCompletion, recordedAt: Date, result: ContentRef | undefined): AttemptReceipt;
    receiptAudit(invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>, cause: AuditRecord | undefined, receipt: Receipt): AuditRecord;
}
export interface CanonicalBatchFinalAdmissionContext<Lease, Authority, Domain, PathEpochs, Admission> {
    readonly invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>;
    readonly claim: ItemClaim<Lease>;
    readonly authorityAdmission: AuthorityAdmissionReference<Admission>;
    readonly admittedAt: Date;
}
/**
 * `cancelled` is the §5.6 boundary rather than a second flavour of denial. Admission is the
 * commit point a handle names, so an expiry, cancellation, or loss of the required Turn or Run
 * observed here is a `cancelledPreEffect` Receipt over an item with no EffectAttempt, and
 * nothing is detached; after admission the same fact reaches the attempt instead and §7.4
 * names it `aborted`. Collapsing the two into `denied` would report a cancelled Run's batch as
 * `denied` and would claim an authority decision that was never made.
 */
export type CanonicalBatchFinalAdmissionResult = {
    readonly kind: "admitted";
    readonly evidence?: unknown;
} | {
    readonly kind: "denied";
    readonly reason: string;
} | {
    readonly kind: "cancelled";
    readonly reason: string;
};
/**
 * The target's own admission evidence, carried to the handler as `OperationContext`'s
 * `targetAdmission`. It is named off the result that produces it so the two cannot drift and
 * so no second declaration widens the type.
 */
export type CanonicalBatchTargetAdmission = Extract<CanonicalBatchFinalAdmissionResult, {
    readonly kind: "admitted";
}>["evidence"];
export interface CanonicalBatchFinalAdmissionPort<Transaction, Authorization, Lease, Authority, Domain, PathEpochs, Admission> {
    admit(transaction: Transaction, request: CanonicalBatchInvocationRequest<Authorization>, context: CanonicalBatchFinalAdmissionContext<Lease, Authority, Domain, PathEpochs, Admission>): CanonicalBatchFinalAdmissionResult;
}
/**
 * The live resources one attempt runs against. The bound and the hosting domain are here
 * rather than on the PreparedInvocation because §7.4 asks the host to derive a failure kind
 * from a seam it controls, and §8.3 forbids a durable record from owning live substrate
 * resources. A host that sets no bound on an attempt says so with `undefined`.
 */
export interface CanonicalBatchAttemptResources {
    readonly signal: AbortSignal;
    readonly content: ContentStore;
    readonly deadline: Date | undefined;
    readonly target: AttemptTargetDomain;
}
export interface CanonicalBatchResourcesPort<Authorization> {
    resources(request: CanonicalBatchInvocationRequest<Authorization>, itemIndex: number): CanonicalBatchAttemptResources;
}
/**
 * Everything live one admitted item's execution runs against: the handler the pinned Operation
 * exposes, the resources that handler observes, and the target's own admission evidence.
 *
 * Admission and execution are separate steps, so the live half is a value rather than a closure
 * the admitting call happened to hold. An in-Turn invocation passes its own live request; a
 * detached item's target rebuilds one from durable records after the issuing Turn is gone. Both
 * reach the same execution step, which is what keeps one §7.4 classification path for both.
 *
 * It carries exactly what the execution reads — the declared output shape and the handler call —
 * and deliberately not a whole `MediatedInvocationRequest`. The rest of that shape is inert on
 * the execution path, and three of its fields (the request key, the full authority intent, the
 * interceptor traces) are not reconstructible from durable records: a rebuilt target would have
 * to fabricate them to satisfy the type, and a seam that demands fabricated authority evidence
 * is not a seam. The admitting Turn still supplies the full request where those fields genuinely
 * exist.
 */
export interface CanonicalBatchItemExecution {
    /** The pinned Operation's declared shape, read for the output the handler must satisfy. */
    readonly descriptor: OperationDescriptor;
    /** The Operation's handler, exactly as an in-Turn invocation would call it. */
    execute(itemIndex: number, context: OperationContext): Promise<FacetData>;
    readonly resources: CanonicalBatchAttemptResources;
    readonly targetAdmission: CanonicalBatchTargetAdmission;
}
/**
 * What the admission step reached for one item: a durable EffectAttempt that no Receipt names
 * yet, or a Receipt that ends the item before any effect.
 *
 * The admitted case carries the item and never a Receipt, because that is the entire point of
 * separating the steps: §5.6's handle is built over an item whose work has been admitted and
 * has not happened, and a value that could carry an outcome would let a Run publish a handle
 * for an item that already finished.
 */
export type CanonicalBatchItemAdmission = {
    readonly kind: "admitted";
    readonly item: AdmittedInvocationItem;
    readonly targetAdmission: CanonicalBatchTargetAdmission;
} | {
    readonly kind: "terminal";
    readonly itemIndex: number;
    readonly receipt: Receipt;
};
export declare class CanonicalBatchInvocationPort<Authorization, Transaction, Lease, Authority, Domain, PathEpochs, Admission, Authentication = undefined, Denial = never> implements CanonicalBatchInvoker<Authorization> {
    #private;
    private readonly transactions;
    private readonly persistence;
    private readonly detachedExecutions;
    private readonly ledger;
    private readonly preparation;
    private readonly permits;
    private readonly authentication;
    private readonly records;
    private readonly finalAdmission;
    private readonly evidence;
    private readonly resources;
    private readonly now;
    constructor(transactions: InvocationTransactionPort<Transaction>, persistence: InvocationPersistence<Transaction, Lease, Authority, Domain, PathEpochs, Admission>, detachedExecutions: DetachedEffectExecutionPersistence<Transaction>, ledger: InvocationLedger<Transaction, Lease, Authority, Domain, PathEpochs, Admission, Authentication>, preparation: CanonicalBatchPreparationPort<Authorization, Lease, Authority, Domain, PathEpochs>, permits: CanonicalBatchAuthorityPermitPort<Transaction, Lease, Authority, Domain, PathEpochs, Admission, Denial>, authentication: CanonicalBatchAuthorityAuthenticationPort<Lease, Authority, Domain, PathEpochs, Admission, Authentication>, records: CanonicalBatchRecordPort<Lease, Authority, Domain, PathEpochs, Admission>, finalAdmission: CanonicalBatchFinalAdmissionPort<Transaction, Authorization, Lease, Authority, Domain, PathEpochs, Admission>, evidence: InvocationEvidencePersistence<Transaction>, resources: CanonicalBatchResourcesPort<Authorization>, now: () => Date);
    invoke(request: CanonicalBatchInvocationRequest<Authorization>): Promise<CanonicalBatchInvocationResult>;
    /**
     * Admits one item's effect and records that its execution has left the issuing Turn, in one
     * transaction (§5.6, C13-TURN-HANDLE-DETACHMENT).
     *
     * The EffectAttempt and the detachment record commit together because either alone is a
     * lie: an attempt with no detachment record is an item nothing will ever execute after a
     * restart, and a detachment record with no attempt names work that was never admitted.
     * Nothing runs here, so the caller can publish an admission identity over an item that has
     * an attempt and no Receipt — which is the fact §5.6's handle needs and the one a truthful
     * settlement view cannot obtain from a Receipt.
     */
    admitDetachedItem(request: CanonicalBatchInvocationRequest<Authorization>, itemIndex: number): Promise<CanonicalBatchItemAdmission>;
    /**
     * Runs one admitted item against the live resources it was given, and records its Receipt.
     *
     * It re-reads its own state first and takes the item as durable facts rather than as a
     * closure, so the same step serves the Turn that admitted the item and a driver that
     * rebuilt it from records after a restart. A Receipt that already exists replays instead of
     * running the effect again (§7.3's idempotency), which is what makes a duplicated delivery
     * a no-op rather than a second external effect.
     */
    executeAdmittedItem(item: AdmittedInvocationItem, execution: CanonicalBatchItemExecution): Promise<CanonicalBatchItemResult>;
    /** Records the PreparedInvocation once, or requires the stored one to be the same intent. */
    private prepare;
    private invokeItem;
    /**
     * Runs one item's work at most once per process at a time. Two callers naming the same item
     * share the first one's promise, so a redelivery that arrives while the item is running
     * joins the run in flight instead of starting a second effect.
     */
    private once;
    private invokeItemOnce;
    /**
     * Everything up to and including the durable EffectAttempt append: claim, authority permit,
     * permit authentication, and the target's own final admission. `detached` decides only
     * whether the same transaction also records that the item's execution left the Turn.
     */
    private admitItem;
    /**
     * The already-admitted answer for a detached replay: an attempt this host detached earlier
     * and never receipted is the same admitted item, so re-admission returns it instead of
     * declaring the outcome unknown. Without a detachment record the attempt belongs to the
     * in-Turn path, and only that path's own rule applies.
     */
    private readmitDetached;
    /** The stored PreparedInvocation, EffectAttempt, and current Receipt one item names. */
    private admittedItemState;
    private executeAttempt;
    private claim;
    private denyClaim;
    private finish;
    /**
     * The result a stored Receipt already decides. The ContentStore arrives as a closure
     * because only a succeeded Receipt reads content: an in-Turn replay must not build attempt
     * resources for an item whose Receipt needs none, and a detached replay reads through the
     * store its target handed it.
     */
    private resultForReceipt;
}
