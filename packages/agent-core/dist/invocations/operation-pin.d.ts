import { Digest, SemVer, type JsonValue } from "../core/index.js";
import { OperationRef, type Impact, type IsolationMode } from "../facets/index.js";
import { PackageId } from "../definition/index.js";
export interface PlacementPinInit {
    readonly manifest: readonly IsolationMode[];
    readonly policy: readonly IsolationMode[];
    readonly substrate: readonly IsolationMode[];
    readonly trust: readonly IsolationMode[];
    readonly selected: IsolationMode;
}
export declare class InvocationPlacementPin {
    readonly manifest: readonly IsolationMode[];
    readonly policy: readonly IsolationMode[];
    readonly substrate: readonly IsolationMode[];
    readonly trust: readonly IsolationMode[];
    constructor(init: PlacementPinInit);
    readonly selected: IsolationMode;
    toData(): JsonValue;
    static fromData(value: JsonValue): InvocationPlacementPin;
}
export interface OperationPinInit {
    readonly operation: OperationRef;
    readonly target: string;
    readonly package: PackageId;
    readonly version: SemVer;
    readonly manifestDigest: Digest;
    readonly descriptorDigest: Digest;
    readonly configurationDigest: Digest;
    readonly runtimeDigest: Digest;
    readonly activationGeneration: string;
    readonly registration: string;
    readonly impact: Impact;
    readonly approvalRequired: boolean;
    readonly placement: InvocationPlacementPin;
}
export declare class OperationPin {
    readonly operation: OperationRef;
    readonly target: string;
    readonly packageId: PackageId;
    readonly version: SemVer;
    readonly manifestDigest: Digest;
    readonly descriptorDigest: Digest;
    readonly configurationDigest: Digest;
    readonly runtimeDigest: Digest;
    readonly activationGeneration: string;
    readonly registration: string;
    readonly impact: Impact;
    readonly approvalRequired: boolean;
    readonly placement: InvocationPlacementPin;
    constructor(operation: OperationRef, target: string, packageId: PackageId, version: SemVer, manifestDigest: Digest, descriptorDigest: Digest, configurationDigest: Digest, runtimeDigest: Digest, activationGeneration: string, registration: string, impact: Impact, approvalRequired: boolean, placement: InvocationPlacementPin);
    static create(init: OperationPinInit): OperationPin;
    toData(): JsonValue;
    static fromData(value: JsonValue): OperationPin;
}
