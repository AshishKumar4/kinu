import type { ActorRef } from "../actors/index.js";
import { type Revision } from "../core/index.js";
import type { CommandCallerPolicy, CommandEnvelope, CommandPayloadCodec, CurrentLease, ExpectedRevisionPolicy, LeaseTokenPolicy, ProtocolCommand, ProtocolValueCodec } from "../protocol/index.js";
import { ContentRetentionReference, type ContentRetentionPort } from "./retention.js";
import type { InteractionAuditPort, InteractionIdPort, InvocationAdmissionPort, TargetRouteAuthorityPort } from "./ports.js";
import { WorkspacePersistence } from "./persistence.js";
import { AuthenticatedRouteProjection, RouteDelivery } from "./route.js";
export interface TargetProjectionAdmission {
    readonly projection: AuthenticatedRouteProjection;
    readonly retention: ContentRetentionReference;
}
export declare const TARGET_PROJECTION_COMMAND = "workspace.route.project";
export declare abstract class TargetProjectionCommandPort<Read> {
    abstract readonly caller: CommandCallerPolicy;
    abstract readonly expectedRevision: ExpectedRevisionPolicy;
    abstract readonly lease: LeaseTokenPolicy;
    abstract readonly payload: CommandPayloadCodec<TargetProjectionAdmission>;
    abstract readonly resultCodec: ProtocolValueCodec<RouteDelivery>;
    abstract authorize(read: Read, envelope: CommandEnvelope, admission: TargetProjectionAdmission): boolean;
    abstract permitsLifecycle(read: Read, envelope: CommandEnvelope, admission: TargetProjectionAdmission): boolean;
    abstract currentRevision(read: Read, envelope: CommandEnvelope, admission: TargetProjectionAdmission): Revision | undefined;
    abstract currentLease(read: Read, envelope: CommandEnvelope, admission: TargetProjectionAdmission, at: Date): CurrentLease | undefined;
}
export declare class TargetProjectionProtocol<Transaction> {
    private readonly actor;
    private readonly persistence;
    private readonly retention;
    private readonly authority;
    private readonly invocations;
    private readonly audit;
    private readonly ids;
    constructor(actor: ActorRef, persistence: WorkspacePersistence<Transaction>, retention: ContentRetentionPort<Transaction>, authority: TargetRouteAuthorityPort<Transaction>, invocations: InvocationAdmissionPort<Transaction>, audit: InteractionAuditPort<Transaction>, ids: InteractionIdPort);
    admit(transaction: Transaction, input: TargetProjectionAdmission): RouteDelivery;
    /**
     * SPEC §4.1 (C13-FACET-WITHDRAWAL-DRAIN): the durable admission stop of a withdrawn
     * contribution. The transaction that begins a withdrawal retires the Subscriptions the
     * Facet's `commands` and `automations` contributions materialized and freezes its drain
     * set in one Workspace-owned capture, so the set is finite at that transaction. A
     * projection presented afterwards — a reservation the source appended against a view it
     * had already lost, or an at-least-once retry of one — is refused by reading that
     * capture rather than admitted as a new Invocation item, which is what keeps the frozen
     * set from growing across a restart. The reservation then takes the terminal rejected
     * RouteDelivery the withdrawal set requires instead of resolving an unresolvable target.
     *
     * A Subscription no Facet contributed is nobody's withdrawal set (§4.2), so it is
     * admitted on its own terms.
     */
    private withdrawnTarget;
}
export declare function createTargetProjectionProtocolCommand<Transaction, Read>(protocol: TargetProjectionProtocol<Transaction>, port: TargetProjectionCommandPort<Read>): ProtocolCommand<Transaction, Read, TargetProjectionAdmission, RouteDelivery, RouteDelivery>;
