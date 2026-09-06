import { ActorRef } from "../actors/index.js";
import { ContentRef, Digest, RecordCodec } from "../core/index.js";
import { OperationRef, type TrustTier } from "../facets/index.js";
import { PrincipalRef } from "../identity/index.js";
import { AuditRecordId, EventId, InvocationId, RouteProjectionId, RouteReservationId, SubscriptionId } from "../interaction-references/index.js";
import type { RouteAuthority, TenantRelation } from "./value.js";
export interface RouteReservationInit {
    readonly id: RouteReservationId;
    readonly invocation: InvocationId;
    readonly event: EventId;
    readonly sourceAuditCause: AuditRecordId;
    readonly sourceActor: ActorRef;
    readonly targetActor: ActorRef;
    readonly tenants: TenantRelation;
    readonly subscription: SubscriptionId;
    readonly dedupeKey: string;
    readonly operation: OperationRef;
    readonly authority: RouteAuthority;
    readonly projection: RouteProjectionId;
    readonly projectionRef: ContentRef;
    readonly projectionDigest: Digest;
    readonly trust: TrustTier;
    readonly initiator?: PrincipalRef;
}
export declare class RouteReservation {
    static get codec(): RecordCodec<RouteReservation>;
    static encode(reservation: RouteReservation): Uint8Array;
    static decode(bytes: Uint8Array): RouteReservation;
    readonly init: RouteReservationInit;
    constructor(init: RouteReservationInit);
    get id(): RouteReservationId;
    get invocation(): InvocationId;
    get event(): EventId;
    get sourceAuditCause(): AuditRecordId;
    get sourceActor(): ActorRef;
    get targetActor(): ActorRef;
    get tenants(): TenantRelation;
    get subscription(): SubscriptionId;
    get dedupeKey(): string;
    get operation(): OperationRef;
    get authority(): RouteAuthority;
    get projection(): RouteProjectionId;
    get projectionRef(): ContentRef;
    get projectionDigest(): Digest;
    get trust(): TrustTier;
    get initiator(): PrincipalRef | undefined;
}
export interface RouteProjectionInit {
    readonly id: RouteProjectionId;
    readonly reservation: RouteReservationId;
    readonly content: ContentRef;
    readonly digest: Digest;
    readonly authenticationDigest?: Digest;
}
export declare class RouteProjection {
    static get codec(): RecordCodec<RouteProjection>;
    static encode(projection: RouteProjection): Uint8Array;
    static decode(bytes: Uint8Array): RouteProjection;
    readonly init: RouteProjectionInit;
    constructor(init: RouteProjectionInit);
    get id(): RouteProjectionId;
    get reservation(): RouteReservationId;
    get content(): ContentRef;
    get digest(): Digest;
    get authenticationDigest(): Digest | undefined;
    get authenticated(): boolean;
    authenticate(digest: Digest): RouteProjection;
}
export declare abstract class RouteDeliveryState {
    static delivered(): RouteDeliveryState;
    static rejected(reason: string): RouteDeliveryState;
    abstract readonly kind: "delivered" | "rejected";
    abstract readonly reason: string | undefined;
    equals(other: RouteDeliveryState): boolean;
}
export interface RouteDeliveryInit {
    readonly reservation: RouteReservationId;
    readonly state: RouteDeliveryState;
    readonly targetAudit: AuditRecordId;
}
export declare class RouteDelivery {
    static get codec(): RecordCodec<RouteDelivery>;
    static encode(delivery: RouteDelivery): Uint8Array;
    static decode(bytes: Uint8Array): RouteDelivery;
    readonly reservation: RouteReservationId;
    readonly state: RouteDeliveryState;
    readonly targetAudit: AuditRecordId;
    constructor(init: RouteDeliveryInit);
}
export interface RouteProjectionEnvelope {
    readonly reservation: RouteReservation;
    readonly projection: RouteProjection;
}
export declare class AuthenticatedRouteProjection {
    readonly envelope: RouteProjectionEnvelope;
    constructor(token: typeof authenticationToken, envelope: RouteProjectionEnvelope);
    readonly digest: Digest;
}
declare const authenticationToken: unique symbol;
export declare function requireAuthenticatedRouteProjection(value: AuthenticatedRouteProjection): asserts value is AuthenticatedRouteProjection;
export declare abstract class RouteProjectionAuthenticator {
    authenticate(input: RouteProjectionEnvelope, evidence: Uint8Array): AuthenticatedRouteProjection;
    protected abstract verify(message: Uint8Array, evidence: Uint8Array): boolean;
}
export declare function routeProjectionEnvelopeBytes(envelope: RouteProjectionEnvelope): Uint8Array;
export {};
