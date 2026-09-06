import { Digest, RecordCodec, type JsonValue } from "../../core/index.js";
import { OperationRef } from "../../facets/index.js";
import { ReceiptId } from "../../invocation-references/index.js";
import { CodecRecord } from "../record-data.js";
import { AcceptanceId } from "./id.js";
export interface AcceptanceCriterionInit {
    readonly id: AcceptanceId;
    readonly operation: OperationRef;
}
export declare class AcceptanceCriterion extends CodecRecord {
    static get codec(): RecordCodec<AcceptanceCriterion>;
    readonly id: AcceptanceId;
    readonly operation: OperationRef;
    constructor(init: AcceptanceCriterionInit);
    toData(): JsonValue;
    static fromData(value: JsonValue): AcceptanceCriterion;
}
export declare const AcceptanceCriterionCodec: RecordCodec<AcceptanceCriterion>;
export interface AcceptanceVerdictInit {
    readonly acceptance: AcceptanceId;
    readonly subject: Digest;
    readonly receipt: ReceiptId;
}
export declare class AcceptanceVerdict extends CodecRecord {
    static get codec(): RecordCodec<AcceptanceVerdict>;
    readonly acceptance: AcceptanceId;
    readonly subject: Digest;
    readonly receipt: ReceiptId;
    constructor(init: AcceptanceVerdictInit);
    toData(): JsonValue;
    static fromData(value: JsonValue): AcceptanceVerdict;
}
export declare const AcceptanceVerdictCodec: RecordCodec<AcceptanceVerdict>;
