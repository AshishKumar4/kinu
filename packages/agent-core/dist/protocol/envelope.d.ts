import { ActorRef } from "../actors/index.js";
import { type LeaseToken } from "../agents/index.js";
import { ContentRef, Digest, RecordCodec, Revision, type JsonValue } from "../core/index.js";
import { PrincipalRef } from "../identity/index.js";
import { AuditRecordId } from "../invocations/index.js";
export type { LeaseToken } from "../agents/index.js";
export type CommandCaller = {
    readonly kind: "principal";
    readonly principal: PrincipalRef;
} | {
    readonly kind: "actor";
    readonly actor: ActorRef;
};
export interface CommandEnvelopeInit {
    readonly command: string;
    readonly caller: CommandCaller;
    readonly idempotencyKey: string;
    readonly expectedRevision?: Revision | undefined;
    readonly lease?: LeaseToken | undefined;
    readonly callerCause?: AuditRecordId | undefined;
    readonly payload: ContentRef;
    readonly payloadDigest: Digest;
}
export declare class CommandEnvelope {
    static get codec(): RecordCodec<CommandEnvelope>;
    readonly command: string;
    readonly caller: CommandCaller;
    readonly idempotencyKey: string;
    readonly expectedRevision: Revision | undefined;
    readonly lease: LeaseToken | undefined;
    readonly callerCause: AuditRecordId | undefined;
    readonly payload: ContentRef;
    readonly payloadDigest: Digest;
    constructor(init: CommandEnvelopeInit);
    static encode(envelope: CommandEnvelope): Uint8Array;
    static decode(bytes: Uint8Array): CommandEnvelope;
}
export declare const CommandEnvelopeCodec: RecordCodec<CommandEnvelope>;
export declare function commandCallersEqual(left: CommandCaller, right: CommandCaller): boolean;
export declare function copyCommandCaller(caller: CommandCaller): CommandCaller;
export declare function encodeCommandCaller(caller: CommandCaller): JsonValue;
export declare function decodeCommandCaller(value: JsonValue | undefined): CommandCaller;
