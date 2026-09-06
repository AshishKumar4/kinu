import { ActorRef } from "../actors/index.js";
import { Digest, RecordCodec, type JsonValue, type RecordVersion } from "../core/index.js";
import { type FacetData } from "../facets/index.js";
import { type StructuralCodec } from "./codec.js";
import { AuditRecordId, InvocationId, RouteReservationId } from "../interaction-references/index.js";
import { OperationPin } from "./operation-pin.js";
export interface PreparedInvocationCodecs<Lease, Authority, Domain, PathEpochs> {
    readonly lease: StructuralCodec<Lease>;
    readonly authority: StructuralCodec<Authority>;
    readonly domain: StructuralCodec<Domain>;
    readonly pathEpochs: StructuralCodec<PathEpochs>;
}
export interface PreparedInvocationHeaderInit<Lease, Authority, Domain, PathEpochs> {
    readonly id: InvocationId;
    readonly operation: OperationPin;
    readonly domain: Domain;
    readonly actor: ActorRef;
    readonly authority: Authority;
    readonly pathEpochs: PathEpochs;
    readonly lease?: Lease | undefined;
    readonly route?: RouteReservationId | undefined;
    readonly projectionDigest?: Digest | undefined;
    readonly auditCause: AuditRecordId;
    readonly idempotencySeed: string;
}
export declare class PreparedInvocationHeader<Lease, Authority, Domain, PathEpochs> {
    readonly id: InvocationId;
    readonly operation: OperationPin;
    readonly domain: Domain;
    readonly actor: ActorRef;
    readonly authority: Authority;
    readonly pathEpochs: PathEpochs;
    readonly lease: Lease | undefined;
    readonly route: RouteReservationId | undefined;
    readonly projectionDigest: Digest | undefined;
    readonly auditCause: AuditRecordId;
    readonly idempotencySeed: string;
    constructor(id: InvocationId, operation: OperationPin, domain: Domain, actor: ActorRef, authority: Authority, pathEpochs: PathEpochs, lease: Lease | undefined, route: RouteReservationId | undefined, projectionDigest: Digest | undefined, auditCause: AuditRecordId, idempotencySeed: string);
}
export declare class PreparedItem {
    readonly idempotencyKey: string;
    readonly arguments: FacetData;
    constructor(argumentsValue: FacetData, idempotencyKey: string);
}
export type PreparedPayload = {
    readonly kind: "single";
    readonly item: PreparedItem;
} | {
    readonly kind: "batch";
    readonly items: readonly [PreparedItem, ...PreparedItem[]];
};
export type UnpreparedPayload = {
    readonly kind: "single";
    readonly item: FacetData;
} | {
    readonly kind: "batch";
    readonly items: readonly [FacetData, ...FacetData[]];
};
export declare class PreparedInvocation<Lease, Authority, Domain, PathEpochs> {
    readonly header: PreparedInvocationHeader<Lease, Authority, Domain, PathEpochs>;
    readonly payload: PreparedPayload;
    readonly intentDigest: Digest;
    private constructor();
    static encode<Lease, Authority, Domain, PathEpochs>(record: PreparedInvocation<Lease, Authority, Domain, PathEpochs>, codecs: PreparedInvocationCodecs<Lease, Authority, Domain, PathEpochs>): Uint8Array;
    static decode<Lease, Authority, Domain, PathEpochs>(bytes: Uint8Array, codecs: PreparedInvocationCodecs<Lease, Authority, Domain, PathEpochs>): PreparedInvocation<Lease, Authority, Domain, PathEpochs>;
    static create<Lease, Authority, Domain, PathEpochs>(init: PreparedInvocationHeaderInit<Lease, Authority, Domain, PathEpochs>, payload: UnpreparedPayload, codecs: PreparedInvocationCodecs<Lease, Authority, Domain, PathEpochs>): PreparedInvocation<Lease, Authority, Domain, PathEpochs>;
    get itemCount(): number;
    item(index: number): PreparedItem;
}
export declare class PreparedInvocationCodec<Lease, Authority, Domain, PathEpochs> extends RecordCodec<PreparedInvocation<Lease, Authority, Domain, PathEpochs>> {
    #private;
    constructor(codecs: PreparedInvocationCodecs<Lease, Authority, Domain, PathEpochs>);
    protected encodePayload(record: PreparedInvocation<Lease, Authority, Domain, PathEpochs>): JsonValue;
    protected decodePayload(payload: JsonValue, _version: RecordVersion): PreparedInvocation<Lease, Authority, Domain, PathEpochs>;
}
