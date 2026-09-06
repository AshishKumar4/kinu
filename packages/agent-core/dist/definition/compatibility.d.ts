import { RecordCodec, SemVer, type JsonValue } from "../core/index.js";
export interface PlatformCompatibilityInit {
    readonly spec: SemVer;
    readonly host: SemVer;
}
export declare class PlatformCompatibility {
    static get codec(): RecordCodec<PlatformCompatibility>;
    readonly spec: SemVer;
    readonly host: SemVer;
    constructor(init: PlatformCompatibilityInit);
    static encode(target: PlatformCompatibility): Uint8Array;
    static decode(bytes: Uint8Array): PlatformCompatibility;
    static fromData(value: JsonValue): PlatformCompatibility;
    equals(other: PlatformCompatibility): boolean;
    toData(): JsonValue;
}
export declare function canonicalCompatibilityRange(value: string, subject: string): string;
export declare function compatibilityAdmits(range: {
    readonly spec: string;
    readonly host: string;
}, target: PlatformCompatibility): boolean;
