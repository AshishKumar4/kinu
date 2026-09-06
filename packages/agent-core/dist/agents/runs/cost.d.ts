import { TextId, type JsonValue } from "../../core/index.js";
/**
 * The currency one Run lineage records every realized cost in (SPEC §5.2). The rate source
 * is out of scope, so this platform compares codes for equality and never interprets them.
 * The code is opaque text for that reason, and identity is by type and value like every
 * other `TextId`.
 */
export declare class Currency extends TextId {
    constructor(value: string);
}
/**
 * One model call's realized cost, as the call incurred it (SPEC §5.2). `micros` is integer
 * millionths of the currency's major unit.
 *
 * There is no estimated form of this value, and that absence is the rule rather than an
 * omission: a host with no realized cost to record declares the `costMicros` dimension
 * nowhere, so a host that has nothing to report has nothing to build here either. The value
 * travels from the executor seam to the Run's running total unchanged, so a rate table can
 * produce the number a host reports but can never stand in for a cost the call incurred.
 */
export declare class RealizedCost {
    readonly micros: number;
    readonly currency: Currency;
    constructor(micros: number, currency: Currency);
    equals(other: RealizedCost): boolean;
    toData(): JsonValue;
    static fromData(value: JsonValue): RealizedCost;
}
