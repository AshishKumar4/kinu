import type { FacetData } from "../data.js";
export declare class ProfileWireCodec<Value> {
    private readonly encodeValue;
    private readonly decodeValue;
    constructor(encodeValue: (value: Value) => FacetData, decodeValue: (data: FacetData) => Value);
    encode(value: Value): FacetData;
    decode(data: FacetData): Value;
}
export declare class VersionedProfileWireCodec<Value> extends ProfileWireCodec<Value> {
    readonly major: number;
    readonly minor: number;
    private readonly supported;
    constructor(encodeValue: (value: Value) => FacetData, decodeValue: (data: FacetData) => Value, major?: number, minor?: number);
    decodeVersion(version: {
        readonly major: number;
        readonly minor: number;
    }, data: FacetData): Value;
}
export declare function profileWireCodec<Value>(encode: (value: Value) => FacetData, decode: (data: FacetData) => Value): ProfileWireCodec<Value>;
export declare function versionedProfileWireCodec<Value>(encode: (value: Value) => FacetData, decode: (data: FacetData) => Value): VersionedProfileWireCodec<Value>;
export declare function facetDataWireCodec(): ProfileWireCodec<FacetData>;
export declare const voidProfileWireCodec: ProfileWireCodec<void>;
