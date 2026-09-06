import { ActorRef } from "../actors/index.js";
import { Digest, RecordCodec, type JsonValue } from "../core/index.js";
import { AuditRecordId, WriteRecordId } from "../invocations/index.js";
import { type CommandCaller } from "./envelope.js";
export type CommandOutcome = "committed" | "rejectedMalformed" | "rejectedAuthentication" | "rejectedAuthority" | "rejectedLifecycle" | "rejectedRevision" | "rejectedLease" | "duplicate";
/** Whether an outcome records the command's refusal, read from the declared partition. */
export declare function commandOutcomeRefused(outcome: CommandOutcome): boolean;
/** Whether a decoded value is an outcome SPEC §8.5 declares, decided from the same table. */
export declare function isCommandOutcome(value: JsonValue | undefined): value is CommandOutcome;
export interface WriteRecordInit {
    readonly id: WriteRecordId;
    readonly actor: ActorRef;
    readonly envelopeDigest: Digest;
    readonly caller?: CommandCaller | undefined;
    readonly command?: string | undefined;
    readonly idempotencyKey?: string | undefined;
    readonly at: Date;
    readonly outcome: CommandOutcome;
    readonly audit: AuditRecordId;
    readonly duplicateOf?: WriteRecordId | undefined;
    readonly reply: Uint8Array;
    readonly observation?: Uint8Array | undefined;
}
export declare class WriteRecord {
    #private;
    static get codec(): RecordCodec<WriteRecord>;
    readonly id: WriteRecordId;
    readonly actor: ActorRef;
    readonly envelopeDigest: Digest;
    readonly caller: CommandCaller | undefined;
    readonly command: string | undefined;
    readonly idempotencyKey: string | undefined;
    readonly outcome: CommandOutcome;
    readonly audit: AuditRecordId;
    readonly duplicateOf: WriteRecordId | undefined;
    constructor(init: WriteRecordInit);
    static encode(record: WriteRecord): Uint8Array;
    static decode(bytes: Uint8Array): WriteRecord;
    get at(): Date;
    get reply(): Uint8Array;
    get observation(): Uint8Array | undefined;
}
export declare const WriteRecordCodec: RecordCodec<WriteRecord>;
export declare function writeReservesIdentity(record: WriteRecord): boolean;
