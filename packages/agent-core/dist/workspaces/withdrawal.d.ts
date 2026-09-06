import { RecordCodec } from "../core/index.js";
import { ContributionAttribution } from "../facets/index.js";
import { InvocationId, type AuditRecordId, type RouteReservationId, type SubscriptionId } from "../interaction-references/index.js";
import type { WorkspacePersistence } from "./persistence.js";
import type { Subscription } from "./subscription.js";
/** The routing records one withdrawal retired, and the reservations it terminated. */
export interface RoutingWithdrawal {
    readonly subscriptions: readonly SubscriptionId[];
    readonly rejected: readonly RouteReservationId[];
}
/** Mints the audit identity the owning Actor writes each terminal rejection under. */
export interface RoutingWithdrawalAuditPort {
    deliveryAudit(): AuditRecordId;
}
export declare const WITHDRAWN_TARGET_REASON = "facet-withdrawn";
/**
 * SPEC §4.1 (C13-FACET-WITHDRAWAL-EXACT): the routing Actor's half of a withdrawal. It
 * retires the Subscriptions the named `ContributionAttribution` — the exact FacetRef and
 * PackagePin pair — materialized, so no further reservation is appended against an
 * unresolvable target, and it admits every reservation already appended and not yet
 * prepared to a terminal rejected RouteDelivery. A reservation that reached preparation is
 * left alone: it drains as an Invocation item under C13-FACET-WITHDRAWAL-DRAIN. Another
 * release of the same Facet is a different contribution and owns a different withdrawal.
 */
export declare class WorkspaceRoutingWithdrawal<Transaction> {
    private readonly persistence;
    private readonly audits;
    constructor(persistence: WorkspacePersistence<Transaction>, audits: RoutingWithdrawalAuditPort);
    contributed(transaction: Transaction, attribution: ContributionAttribution): readonly Subscription[];
    retire(transaction: Transaction, attribution: ContributionAttribution): RoutingWithdrawal;
}
/**
 * SPEC §4.1 (C13-FACET-WITHDRAWAL-DRAIN): the Workspace Actor's durable capture of one
 * withdrawal's drain set. The transaction that begins a withdrawal stops admitting
 * Invocations against the withdrawing Facet, so the admitted items are finite at that
 * transaction and never grow; this record is that set, frozen, written in the same
 * transaction that retires the records. A later completion attempt reads the captured items
 * rather than querying again — a host can neither report completion by discarding a live
 * item nor be held open by an item admitted after admission stopped — and a later admission
 * reads the capture to refuse the release it names, which is what makes the stop survive a
 * restart instead of living only inside the transaction that froze the set.
 *
 * The captured items carry no terminality. Whether an item has reached a terminal current
 * Receipt is the Invocation plane's answer (§7.4), read at each completion attempt, so this
 * record holds no second copy of Receipt state (§8.4).
 */
export declare class WithdrawalDrainCapture {
    static get codec(): RecordCodec<WithdrawalDrainCapture>;
    static encode(capture: WithdrawalDrainCapture): Uint8Array;
    static decode(bytes: Uint8Array): WithdrawalDrainCapture;
    /** The record key of the withdrawal of one exact contribution: FacetRef and PackagePin. */
    static keyFor(attribution: ContributionAttribution): string;
    readonly attribution: ContributionAttribution;
    readonly items: readonly InvocationId[];
    constructor(attribution: ContributionAttribution, items: readonly InvocationId[]);
    get key(): string;
    /** True exactly when the captured set names this item, so nothing else can drain here. */
    captures(item: InvocationId): boolean;
}
