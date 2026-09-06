import { RecordCodec, type JsonValue } from "../../core/index.js";
import { ReceiptId } from "../../invocation-references/index.js";
import { AuditRecordId, EventId } from "../../interaction-references/index.js";
import { CodecRecord } from "../record-data.js";
import { RunId, TurnId } from "./id.js";
export interface ForcedTurnCancellationInit {
    readonly run: RunId;
    readonly terminalTurn: TurnId;
    readonly turn: TurnId;
    readonly priorLeaseEpoch: number;
    readonly fencedLeaseEpoch: number;
    readonly controlReceipt: ReceiptId;
    readonly controlAudit: AuditRecordId;
    readonly cancellationEvent: EventId;
    readonly cancellationAudit: AuditRecordId;
}
export declare class ForcedTurnCancellation extends CodecRecord {
    static get codec(): RecordCodec<ForcedTurnCancellation>;
    static encode<Value>(this: {
        readonly codec: RecordCodec<Value>;
    }, value: Value): Uint8Array;
    static decode<Value>(this: {
        readonly codec: RecordCodec<Value>;
    }, bytes: Uint8Array): Value;
    readonly run: RunId;
    readonly terminalTurn: TurnId;
    readonly turn: TurnId;
    readonly priorLeaseEpoch: number;
    readonly fencedLeaseEpoch: number;
    readonly controlReceipt: ReceiptId;
    readonly controlAudit: AuditRecordId;
    readonly cancellationEvent: EventId;
    readonly cancellationAudit: AuditRecordId;
    constructor(init: ForcedTurnCancellationInit);
    toData(): JsonValue;
    static fromData(value: JsonValue): ForcedTurnCancellation;
}
export declare const ForcedTurnCancellationCodec: RecordCodec<ForcedTurnCancellation>;
