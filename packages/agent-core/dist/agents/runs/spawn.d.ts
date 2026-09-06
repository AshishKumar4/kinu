import { ContentRef, type ContentRetentionField, Digest, type JsonValue, RecordCodec } from "../../core/index.js";
import { TurnId } from "../../execution-references/index.js";
import { ReceiptId } from "../../invocation-references/index.js";
import { InvocationId } from "../../interaction-references/index.js";
import { CodecRecord } from "../record-data.js";
import type { SpawnAttenuation } from "./ceiling.js";
import { RunId, SpawnReservationId } from "./id.js";
import { type LeaseToken } from "./lease.js";
export declare class SpawnReservation extends CodecRecord {
    #private;
    readonly id: SpawnReservationId;
    readonly parentRun: RunId;
    readonly parentTurn: TurnId;
    readonly childRun: RunId;
    readonly configuration: Digest;
    readonly rootContent: ContentRef;
    readonly invocation: InvocationId;
    readonly receipt: ReceiptId;
    readonly attenuation: Digest;
    static get codec(): RecordCodec<SpawnReservation>;
    constructor(id: SpawnReservationId, parentRun: RunId, parentTurn: TurnId, childRun: RunId, token: LeaseToken, configuration: Digest, rootContent: ContentRef, invocation: InvocationId, receipt: ReceiptId, attenuation: Digest, recordedAt: Date);
    readonly token: LeaseToken;
    get recordedAt(): Date;
    toData(): JsonValue;
    static fromData(value: JsonValue): SpawnReservation;
}
export declare function spawnReservationContentRetention(value: SpawnReservation): readonly ContentRetentionField[];
export declare const SpawnReservationCodec: RecordCodec<SpawnReservation>;
export declare abstract class RunSpawnPort<Transaction> {
    abstract verify(transaction: Transaction, reservation: SpawnReservation): boolean;
    abstract attenuation(transaction: Transaction, reservation: SpawnReservation): SpawnAttenuation;
}
