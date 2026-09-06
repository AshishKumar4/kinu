import { Digest, RecordCodec, Revision } from "../core/index.js";
import type { ReceiptObservation } from "./ports.js";
export type InvocationPublicationState = {
    readonly kind: "pending";
    readonly eventPublishedAt?: Date;
    readonly commitAppendedAt?: Date;
} | {
    readonly kind: "published";
    readonly eventPublishedAt: Date;
    readonly commitAppendedAt: Date;
};
export declare class InvocationPublicationOutbox {
    #private;
    readonly observation: ReceiptObservation;
    readonly revision: Revision;
    readonly id: Digest;
    constructor(observation: ReceiptObservation, state: InvocationPublicationState, revision: Revision);
    static pending(observation: ReceiptObservation): InvocationPublicationOutbox;
    static encode(record: InvocationPublicationOutbox): Uint8Array;
    static decode(bytes: Uint8Array): InvocationPublicationOutbox;
    get state(): InvocationPublicationState;
    eventPublished(at: Date): InvocationPublicationOutbox;
    commitAppended(at: Date): InvocationPublicationOutbox;
    follows(current: InvocationPublicationOutbox): boolean;
    private acknowledge;
}
export declare const InvocationPublicationOutboxCodec: RecordCodec<InvocationPublicationOutbox>;
