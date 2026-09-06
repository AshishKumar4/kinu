import type { FacetData } from "./data.js";
import { FacetPackageId } from "./id.js";
export declare class JsonPointer {
    readonly value: string;
    readonly tokens: readonly string[];
    constructor(value: string);
}
export declare class FieldMove {
    readonly to: string;
    readonly from: string | undefined;
    readonly literal: FacetData | undefined;
    constructor(to: string, init: {
        readonly from: string;
    } | {
        readonly literal: FacetData;
    });
    static fromData(payload: FacetData): FieldMove;
    static encode(move: FieldMove): Uint8Array;
    static decode(bytes: Uint8Array): FieldMove;
    toData(): FacetData;
}
export declare abstract class MappingRecord {
    readonly moves: readonly FieldMove[];
    protected constructor(moves: readonly FieldMove[]);
    toData(): FacetData;
}
export declare class FieldMapping extends MappingRecord {
    constructor(moves: readonly FieldMove[]);
    static encode(mapping: FieldMapping): Uint8Array;
    static decode(bytes: Uint8Array): FieldMapping;
}
export declare class PayloadMapping extends MappingRecord {
    static get identity(): PayloadMapping;
    constructor(moves: readonly FieldMove[]);
    static encode(mapping: PayloadMapping): Uint8Array;
    static decode(bytes: Uint8Array): PayloadMapping;
}
export declare class ProvenanceMapping extends MappingRecord {
    constructor(moves: readonly FieldMove[]);
    static encode(mapping: ProvenanceMapping): Uint8Array;
    static decode(bytes: Uint8Array): ProvenanceMapping;
}
export declare class OperationPattern {
    readonly operation: string;
    readonly facet: FacetPackageId | undefined;
    constructor(operation: string, facet?: FacetPackageId);
    static own(operation?: string): OperationPattern;
    static fromData(payload: FacetData): OperationPattern;
    static encode(pattern: OperationPattern): Uint8Array;
    static decode(bytes: Uint8Array): OperationPattern;
    toData(): FacetData;
}
export declare class OperationSelector {
    readonly patterns: readonly OperationPattern[];
    constructor(patterns: readonly OperationPattern[]);
    static own(operation?: string): OperationSelector;
    static encode(selector: OperationSelector): Uint8Array;
    static decode(bytes: Uint8Array): OperationSelector;
    toData(): FacetData;
}
