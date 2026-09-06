import { ActorId, type ActorRef } from "../actors/index.js";
import { RecordCodec, type Revision } from "../core/index.js";
import { PrincipalId, PrincipalRef, TenantId, type TenantKind } from "../identity/index.js";
import type { ProtocolCommand } from "./dispatcher.js";
export interface TenantBootstrapAnchor {
    readonly actorId: ActorId;
    readonly tenantId: TenantId;
    readonly principalId: PrincipalId;
    readonly trustAnchor: Uint8Array;
    readonly tenantKind?: TenantKind;
}
export declare class TenantBootstrapAnchorRecord implements TenantBootstrapAnchor {
    #private;
    static get codec(): RecordCodec<TenantBootstrapAnchorRecord>;
    readonly actorId: ActorId;
    readonly tenantId: TenantId;
    readonly principalId: PrincipalId;
    readonly tenantKind: TenantKind;
    constructor(anchor: TenantBootstrapAnchor);
    static encode(anchor: TenantBootstrapAnchorRecord): Uint8Array;
    static decode(bytes: Uint8Array): TenantBootstrapAnchorRecord;
    get trustAnchor(): Uint8Array;
}
interface TenantBootstrapStore<Transaction, Read> {
    anchor(read: Read): TenantBootstrapAnchor | undefined;
    anchorInTransaction(transaction: Transaction): TenantBootstrapAnchor | undefined;
    eligible(read: Read, anchor: TenantBootstrapAnchor): boolean;
    currentRevision(read: Read, anchor: TenantBootstrapAnchor): Revision;
    bootstrapTenant(transaction: Transaction, anchor: TenantBootstrapAnchorRecord, expectedRevision: Revision): void;
}
export interface TenantBootstrapTarget {
    readonly actor: ActorRef;
    readonly tenantId: TenantId;
}
export interface TenantBootstrapReply {
    readonly owner: PrincipalRef;
    readonly tenant: TenantId;
}
export interface TenantBootstrapObservation {
    readonly at: Date;
    readonly owner: PrincipalRef;
    readonly tenant: TenantId;
}
type EmptyBootstrapPayload = Readonly<Record<string, never>>;
export declare function tenantBootstrapPayload(): Uint8Array;
export declare function createTenantBootstrapCommand<Transaction, Read>(store: TenantBootstrapStore<Transaction, Read>, target: TenantBootstrapTarget): ProtocolCommand<Transaction, Read, EmptyBootstrapPayload, TenantBootstrapReply, TenantBootstrapObservation>;
export {};
