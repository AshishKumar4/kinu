import { Digest, RecordCodec, type JsonValue } from "../core/index.js";
import { PlatformCompatibility } from "./compatibility.js";
export interface ValidationAttestationInit {
    readonly definitionDigest: Digest;
    readonly blueprintDigest: Digest;
    readonly packageLockDigest: Digest;
    readonly snapshotDigest: Digest;
    readonly configSchemaDigest: Digest;
    readonly declarationDigest: Digest;
    readonly placementDigest: Digest;
    readonly target: PlatformCompatibility;
    readonly validatorVersion?: string;
    readonly id?: Digest;
}
export declare class ValidationAttestation {
    static get codec(): RecordCodec<ValidationAttestation>;
    static readonly currentValidatorVersion = "definition-validator.v1";
    readonly id: Digest;
    readonly definitionDigest: Digest;
    readonly blueprintDigest: Digest;
    readonly packageLockDigest: Digest;
    readonly snapshotDigest: Digest;
    readonly configSchemaDigest: Digest;
    readonly declarationDigest: Digest;
    readonly placementDigest: Digest;
    readonly target: PlatformCompatibility;
    readonly validatorVersion: string;
    constructor(init: ValidationAttestationInit);
    static encode(attestation: ValidationAttestation): Uint8Array;
    static decode(bytes: Uint8Array): ValidationAttestation;
    static fromData(value: JsonValue): ValidationAttestation;
    toData(): JsonValue;
}
