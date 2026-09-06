import { Digest, RecordCodec, Revision } from "../core/index.js";
import { type FacetData } from "../facets/index.js";
import { PrincipalRef } from "../identity/index.js";
import type { MediatedReplayExecutionIdentity } from "../operations/index.js";
import { ReceiptId } from "./id.js";
import { InvocationId } from "../interaction-references/index.js";
export type MediatedReplayCardinality = {
    readonly kind: "single";
} | {
    readonly kind: "batch";
    readonly itemCount: number;
};
export interface InvocationInterceptorTrace {
    readonly interceptor: string;
    readonly contributor: string;
    readonly cutPoint: "operation.before" | "operation.after";
    readonly before: Digest;
    readonly after: Digest;
    readonly outcome: "unchanged" | "rewritten";
}
export interface MediatedReplayItem {
    readonly itemIndex: number;
    readonly rawPayloadIdentity: Digest;
    readonly preparedArguments?: FacetData;
    readonly before?: readonly InvocationInterceptorTrace[];
    readonly effectOutput?: FacetData;
    readonly receipt?: ReceiptId;
    readonly after?: readonly InvocationInterceptorTrace[];
    readonly presentation?: FacetData;
}
export interface MediatedReplayReservation {
    readonly scope: string;
    readonly requestKey: string;
    readonly facet: string;
    readonly operation: string;
    readonly descriptorDigest: Digest;
    readonly principal: PrincipalRef;
    readonly authorityIdentity: Digest;
    readonly packageOperationPin: Digest;
    readonly execution: MediatedReplayExecutionIdentity;
    readonly cardinality: MediatedReplayCardinality;
    readonly rawPayloadIdentities: readonly Digest[];
}
export declare class MediatedReplayRecord {
    readonly scope: string;
    readonly requestKey: string;
    readonly facet: string;
    readonly operation: string;
    readonly descriptorDigest: Digest;
    readonly principal: PrincipalRef;
    readonly authorityIdentity: Digest;
    readonly packageOperationPin: Digest;
    readonly execution: MediatedReplayExecutionIdentity;
    readonly cardinality: MediatedReplayCardinality;
    readonly invocation: InvocationId | undefined;
    readonly revision: Revision;
    readonly id: Digest;
    readonly items: readonly MediatedReplayItem[];
    constructor(scope: string, requestKey: string, facet: string, operation: string, descriptorDigest: Digest, principal: PrincipalRef, authorityIdentity: Digest, packageOperationPin: Digest, execution: MediatedReplayExecutionIdentity, cardinality: MediatedReplayCardinality, items: readonly MediatedReplayItem[], invocation: InvocationId | undefined, revision: Revision);
    static reserve(reservation: MediatedReplayReservation): MediatedReplayRecord;
    static encode(record: MediatedReplayRecord): Uint8Array;
    static decode(bytes: Uint8Array): MediatedReplayRecord;
    prepare(invocation: InvocationId, argumentsByItem: readonly FacetData[], tracesByItem: readonly (readonly InvocationInterceptorTrace[])[]): MediatedReplayRecord;
    recordEffect(itemIndex: number, output: FacetData, receipt: ReceiptId): MediatedReplayRecord;
    recordTerminal(itemIndex: number, receipt: ReceiptId): MediatedReplayRecord;
    present(itemIndex: number, traces: readonly InvocationInterceptorTrace[], presentation: FacetData): MediatedReplayRecord;
    get complete(): boolean;
    private requirePreparedItem;
    private replaceItem;
    private transition;
}
export declare const MediatedReplayRecordCodec: RecordCodec<MediatedReplayRecord>;
