import type { ActorRef } from "../actors/index.js";
import type { BindingName, OperationRef } from "../facets/index.js";
import type { PrincipalRef, TenantId } from "../identity/index.js";
import { AuditRecord, type AuditEvidenceResolver, type AuditRecordId, type AuditRecordLookup, type InvocationAuditPersistence, type InvocationLedger, type InvocationPersistence, type PreparedInvocation, type PreparedInvocationHeader } from "../invocations/index.js";
import type { CorrelationId } from "../interaction-references/index.js";
import { Event, type AuthenticatedRouteProjection, type InboxEventReference, type InteractionAuditPort, type InvocationAdmissionDecision, type InvocationAdmissionPort, type RouteDelivery, type RouteReservation, type RoutedInvocationAdmission, type RunInboxOutcome, type RunInboxPort } from "../workspaces/index.js";
import { RunRuntime, TurnInboxEntry, type LeaseToken } from "../agents/index.js";
import type { Revision } from "../core/index.js";
export interface InteractionAuditMetadataPort<Transaction> {
    readonly actor: ActorRef;
    readonly tenant: TenantId;
    records(transaction: Transaction): AuditRecordLookup;
    evidence(transaction: Transaction): AuditEvidenceResolver;
    eventCause(transaction: Transaction, event: Event): AuditRecordId;
    correlationForProjection(transaction: Transaction, projection: AuthenticatedRouteProjection): CorrelationId;
    correlationForDelivery(transaction: Transaction, delivery: RouteDelivery): CorrelationId;
    append(transaction: Transaction, record: AuditRecord, admission?: {
        readonly kind: "routeProjection";
        readonly projection: AuthenticatedRouteProjection["envelope"]["projection"]["id"];
        readonly reservation: RouteReservation["id"];
    }): void;
}
export declare class InvocationInteractionAuditPort<Transaction> implements InteractionAuditPort<Transaction> {
    private readonly metadata;
    constructor(metadata: InteractionAuditMetadataPort<Transaction>);
    appendEvent(transaction: Transaction, event: Event, audit: AuditRecordId): void;
    appendReservation(transaction: Transaction, reservation: RouteReservation, audit: AuditRecordId): void;
    appendProjectionRoot(transaction: Transaction, projection: AuthenticatedRouteProjection, audit: AuditRecordId): void;
    appendDelivery(transaction: Transaction, delivery: RouteDelivery, projectionAudit: AuditRecordId, audit: AuditRecordId): void;
}
export interface RoutedInvocationFactory<Lease, Authority, Domain, PathEpochs> {
    prepare(input: RoutedInvocationAdmission): {
        readonly invocation: PreparedInvocation<Lease, Authority, Domain, PathEpochs>;
        readonly audit: AuditRecord;
    };
}
/**
 * The authority-relevant identity a routed invocation claims, read faithfully from a
 * PreparedInvocationHeader whose Authority and Domain are opaque at this layer. Admission
 * binds each field to the authenticated RouteReservation; a projection that decoupled from
 * the header would defeat that binding, so it is trusted composition wiring rather than the
 * (potentially defective) factory that produced the header.
 */
export interface RoutedInvocationIdentity {
    readonly operation: OperationRef;
    readonly targetActor: ActorRef;
    readonly binding: BindingName;
    readonly principal: PrincipalRef;
}
export interface RoutedInvocationProjection<Lease, Authority, Domain, PathEpochs> {
    identify(header: PreparedInvocationHeader<Lease, Authority, Domain, PathEpochs>): RoutedInvocationIdentity;
}
export declare class RoutedInvocationAdmissionPort<Transaction, Lease, Authority, Domain, PathEpochs, Admission> implements InvocationAdmissionPort<Transaction> {
    private readonly ledger;
    private readonly persistence;
    private readonly factory;
    private readonly projection;
    private readonly audits;
    constructor(ledger: InvocationLedger<Transaction, Lease, Authority, Domain, PathEpochs, Admission>, persistence: InvocationPersistence<Transaction, Lease, Authority, Domain, PathEpochs, Admission>, factory: RoutedInvocationFactory<Lease, Authority, Domain, PathEpochs>, projection: RoutedInvocationProjection<Lease, Authority, Domain, PathEpochs>, audits: InvocationAuditPersistence<Transaction>);
    admit(transaction: Transaction, input: RoutedInvocationAdmission): InvocationAdmissionDecision;
    /**
     * Bind the factory-produced header to the authenticated reservation on every
     * authority-relevant field, mirroring the model's RouteGate. The stable identity checks
     * above leave operation, target owner, authority binding, and principal free; without
     * this a defective factory could keep the checked identifiers yet substitute the operation
     * (a read reservation performing a mutation), retarget the invocation, swap the binding, or
     * impersonate the principal, and still be admitted and persisted. The reservation carries
     * its authenticated principal in `initiator` for both authority kinds; a delegated route
     * may legitimately pin no principal, in which case there is nothing to bind.
     */
    private boundToReservation;
}
export interface RunInboxMaterialPort<Transaction> {
    materialize(transaction: Transaction, reference: InboxEventReference, lease: LeaseToken): {
        readonly entry: TurnInboxEntry;
        readonly expectedTurnRevision: Revision;
        readonly now: Date;
    };
}
export declare class RuntimeRunInboxPort<Transaction> implements RunInboxPort<Transaction> {
    private readonly runtime;
    private readonly material;
    constructor(runtime: RunRuntime<Transaction>, material: RunInboxMaterialPort<Transaction>);
    append(transaction: Transaction, reference: InboxEventReference, lease: LeaseToken): RunInboxOutcome;
}
