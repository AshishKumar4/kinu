import type { ActorRef } from "../actors/index.js";
import { type Revision } from "../core/index.js";
import type { LeaseToken } from "../agents/index.js";
import type { CommandCallerPolicy, CommandEnvelope, CommandPayloadCodec, CurrentLease, ExpectedRevisionPolicy, LeaseTokenPolicy, ProtocolCommand, ProtocolValueCodec } from "../protocol/index.js";
import { ContentRetentionReference, type ContentRetentionPort } from "./retention.js";
import { Event } from "./event.js";
import { AuthenticatedEventIntent, type EventIntentInput } from "./origin.js";
import type { EventPayloadPort, EventTrustPort, InteractionAuditPort, InteractionIdPort, PreparedRouteMaterial, SourceRoutePort } from "./ports.js";
import { WorkspacePersistence } from "./persistence.js";
import { RouteProjection, RouteReservation } from "./route.js";
import type { Subscription } from "./subscription.js";
export type EventDraft = EventIntentInput;
export interface EventRoutingSnapshot {
    readonly event: Event;
    readonly sourceActor: ActorRef;
    readonly payloadRetention: ContentRetentionReference;
    readonly subscriptions: readonly Subscription[];
    readonly dedupedRouteKeys: readonly string[];
    readonly eventAudit: ReturnType<InteractionIdPort["eventAudit"]>;
    readonly lease: LeaseToken | undefined;
    readonly existingEvent: Event | undefined;
}
export interface PreparedRoute {
    readonly subscription: Subscription;
    readonly material: PreparedRouteMaterial;
    readonly reservationId: ReturnType<InteractionIdPort["reservation"]>;
    readonly invocationId: ReturnType<InteractionIdPort["invocation"]>;
    readonly projection: RouteProjection;
    readonly dedupeKey: string;
    readonly reservationAudit: ReturnType<InteractionIdPort["reservationAudit"]>;
}
export declare class PreparedEventRouting {
    constructor(token: typeof preparedRoutingToken, owner: symbol, snapshot: EventRoutingSnapshot, routes: readonly PreparedRoute[]);
}
declare const preparedRoutingToken: unique symbol;
export interface EventAcceptanceResult {
    readonly event: Event;
    readonly duplicate: boolean;
    readonly reservations: readonly RouteReservation[];
}
export declare const SOURCE_EVENT_COMMAND = "workspace.event.accept";
export declare abstract class SourceEventCommandPort<Read> {
    abstract readonly caller: CommandCallerPolicy;
    abstract readonly expectedRevision: ExpectedRevisionPolicy;
    abstract readonly lease: LeaseTokenPolicy;
    abstract readonly payload: CommandPayloadCodec<PreparedEventRouting>;
    abstract readonly resultCodec: ProtocolValueCodec<EventAcceptanceResult>;
    abstract authorize(read: Read, envelope: CommandEnvelope, prepared: PreparedEventRouting): boolean;
    abstract permitsLifecycle(read: Read, envelope: CommandEnvelope, prepared: PreparedEventRouting): boolean;
    abstract currentRevision(read: Read, envelope: CommandEnvelope, prepared: PreparedEventRouting): Revision | undefined;
    abstract currentLease(read: Read, envelope: CommandEnvelope, prepared: PreparedEventRouting, at: Date): CurrentLease | undefined;
}
export declare class SourceEventProtocol<Transaction> {
    #private;
    private readonly actor;
    private readonly persistence;
    private readonly trust;
    private readonly payloads;
    private readonly routes;
    private readonly retention;
    private readonly audit;
    private readonly ids;
    constructor(actor: ActorRef, persistence: WorkspacePersistence<Transaction>, trust: EventTrustPort<Transaction>, payloads: EventPayloadPort, routes: SourceRoutePort<Transaction>, retention: ContentRetentionPort<Transaction>, audit: InteractionAuditPort<Transaction>, ids: InteractionIdPort);
    snapshot(transaction: Transaction, authenticatedIntent: AuthenticatedEventIntent): EventRoutingSnapshot;
    prepare(snapshot: EventRoutingSnapshot): Promise<PreparedEventRouting>;
    commit(transaction: Transaction, prepared: PreparedEventRouting): EventAcceptanceResult;
    private requireSnapshotCurrent;
    private requireTrustCurrent;
}
export declare function createSourceEventProtocolCommand<Transaction, Read>(protocol: SourceEventProtocol<Transaction>, port: SourceEventCommandPort<Read>): ProtocolCommand<Transaction, Read, PreparedEventRouting, EventAcceptanceResult, EventAcceptanceResult>;
export {};
