import type { FacetData } from "./data.js";
import { DataRecordCodec } from "./data.js";
import { BindingName, FacetRef, OperationName } from "./id.js";
export declare class BoundOperationRef {
    readonly binding: BindingName;
    readonly operation: OperationName;
    static get codec(): DataRecordCodec<BoundOperationRef>;
    constructor(binding: BindingName, operation: OperationName);
    static fromData(payload: FacetData): BoundOperationRef;
    equals(other: BoundOperationRef): boolean;
    toData(): FacetData;
}
export declare class FacetOperationRef {
    readonly facet: FacetRef;
    readonly operation: OperationName;
    static get codec(): DataRecordCodec<FacetOperationRef>;
    constructor(facet: FacetRef, operation: OperationName);
    static fromData(payload: FacetData): FacetOperationRef;
    equals(other: FacetOperationRef): boolean;
    toData(): FacetData;
}
