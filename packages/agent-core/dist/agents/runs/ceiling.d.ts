import { RecordCodec, type JsonValue } from "../../core/index.js";
import { CodecRecord } from "../record-data.js";
export declare const RESOURCE_DIMENSIONS: readonly ["costMicros", "depth", "tokens", "wallClockMs"];
export type ResourceDimension = (typeof RESOURCE_DIMENSIONS)[number];
export declare function requireResourceDimension(value: JsonValue | undefined, subject: string): ResourceDimension;
export type ResourceLimits = {
    readonly [Dimension in ResourceDimension]?: number;
};
export declare class ResourceCeiling {
    #private;
    constructor(limits: ResourceLimits);
    get entries(): readonly (readonly [ResourceDimension, number])[];
    get declared(): readonly ResourceDimension[];
    limit(dimension: ResourceDimension): number | undefined;
    equals(other: ResourceCeiling): boolean;
    toData(): JsonValue;
    static fromData(value: JsonValue): ResourceCeiling;
}
export interface ResourceUsage {
    readonly costMicros: number;
    readonly tokens: number;
    readonly wallClockMs: number;
}
export declare function narrowResources(parentRemainder: ResourceCeiling | undefined, declared: ResourceCeiling | undefined, usage: ResourceUsage): ResourceCeiling | undefined;
export declare function widensResourceCeiling(parentRemainder: ResourceCeiling | undefined, child: ResourceCeiling): boolean;
export declare function exhaustedResource(remainder: ResourceCeiling | undefined): ResourceDimension | undefined;
export interface SpawnAttenuationInit {
    readonly ceiling?: ResourceCeiling;
}
export declare class SpawnAttenuation extends CodecRecord {
    static get codec(): RecordCodec<SpawnAttenuation>;
    readonly ceiling: ResourceCeiling | undefined;
    constructor(init?: SpawnAttenuationInit);
    toData(): JsonValue;
    static fromData(value: JsonValue): SpawnAttenuation;
}
export declare const SpawnAttenuationCodec: RecordCodec<SpawnAttenuation>;
