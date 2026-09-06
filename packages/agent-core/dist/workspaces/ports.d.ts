import type { ActorRef } from "../actors/index.js";
import type { ContentRef, Digest, JsonValue } from "../core/index.js";
import type { LeaseToken } from "../agents/index.js";
import type { OperationRef } from "../facets/index.js";
import type { ScopeRef } from "../identity/index.js";
import type { AuditRecordId, InvocationId, RouteProjectionId, RouteReservationId } from "../interaction-references/index.js";
import type { Event } from "./event.js";
import type { InboxEventReference } from "./inbox.js";
import type { ContentRetentionReference } from "./retention.js";
import type { AuthenticatedRouteProjection, RouteDelivery, RouteProjection, RouteReservation } from "./route.js";
import type { Subscription } from "./subscription.js";
import type { DerivedEventTrust, EventProvenance, TenantRelation } from "./value.js";
export interface EventTrustPort<Transaction> {
    derive(transaction: Transaction, actor: ActorRef, scope: ScopeRef, provenance: EventProvenance, lease: LeaseToken | undefined): DerivedEventTrust;
}
export interface EventPayloadPort {
    load(ref: ContentRef, digest: Digest): Promise<JsonValue>;
}
export interface InteractionIdPort {
    reservation(): RouteReservationId;
    projection(): RouteProjectionId;
    invocation(): InvocationId;
    eventAudit(): AuditRecordId;
    reservationAudit(): AuditRecordId;
    projectionAudit(): AuditRecordId;
    deliveryAudit(): AuditRecordId;
    logicalDelivery(): string;
}
export interface PreparedRouteMaterial {
    readonly targetActor: ActorRef;
    readonly tenants: TenantRelation;
    readonly content: ContentRef;
    readonly digest: Digest;
    readonly retention: ContentRetentionReference;
    readonly evidence: JsonValue;
}
export interface RouteMaterialPreparation {
    readonly subscription: Subscription;
    readonly event: Event;
    readonly mappedInput: JsonValue;
    readonly reservation: RouteReservationId;
    readonly projection: RouteProjectionId;
}
export interface SourceRoutePort<Transaction> {
    prepare(input: RouteMaterialPreparation): Promise<PreparedRouteMaterial>;
    authorize(transaction: Transaction, subscription: Subscription, event: Event, material: PreparedRouteMaterial): SourceRouteDecision;
}
export type SourceRouteDecision = {
    readonly kind: "accepted";
    readonly targetActor: ActorRef;
    readonly tenants: TenantRelation;
    readonly operation: OperationRef;
} | {
    readonly kind: "rejected";
};
export interface InteractionAuditPort<Transaction> {
    appendEvent(transaction: Transaction, event: Event, audit: AuditRecordId): void;
    appendReservation(transaction: Transaction, reservation: RouteReservation, audit: AuditRecordId): void;
    appendProjectionRoot(transaction: Transaction, projection: AuthenticatedRouteProjection, audit: AuditRecordId): void;
    appendDelivery(transaction: Transaction, delivery: RouteDelivery, projectionAudit: AuditRecordId, audit: AuditRecordId): void;
}
export type TargetAuthorityDecision = {
    readonly kind: "accepted";
} | {
    readonly kind: "rejected";
    readonly reason: string;
};
export interface TargetRouteAuthorityPort<Transaction> {
    authorize(transaction: Transaction, projection: AuthenticatedRouteProjection): TargetAuthorityDecision;
}
export interface RoutedInvocationAdmission {
    readonly reservation: RouteReservation;
    readonly projection: RouteProjection;
    readonly bridgeAudit: AuditRecordId;
}
export interface InvocationAdmissionPort<Transaction> {
    admit(transaction: Transaction, input: RoutedInvocationAdmission): InvocationAdmissionDecision;
}
export type InvocationAdmissionDecision = {
    readonly kind: "accepted";
    readonly invocation: InvocationId;
} | {
    readonly kind: "rejected";
    readonly reason: string;
};
export interface RunInboxPort<Transaction> {
    append(transaction: Transaction, reference: InboxEventReference, lease: LeaseToken): RunInboxOutcome;
}
export type RunInboxOutcome = {
    readonly kind: "appended";
} | {
    readonly kind: "duplicate";
} | {
    readonly kind: "rejected";
    readonly reason: "lease" | "lifecycle" | "conflict";
};
