import { Digest, RecordCodec, type JsonValue } from "../core/index.js";
import { TenantId } from "../identity/index.js";
import { DeploymentId } from "./id.js";
export interface ManagedOriginInit {
    readonly tenantId: TenantId;
    readonly deploymentId: DeploymentId;
    readonly attestationDigest: Digest;
    readonly blueprintDigest: Digest;
    readonly packageLockDigest: Digest;
    readonly configDigest: Digest;
    readonly generation: number;
}
export declare class ManagedOrigin {
    static get codec(): RecordCodec<ManagedOrigin>;
    readonly blueprintDigest: Digest;
    readonly tenantId: TenantId;
    readonly deploymentId: DeploymentId;
    readonly attestationDigest: Digest;
    readonly packageLockDigest: Digest;
    readonly configDigest: Digest;
    readonly generation: number;
    constructor(init: ManagedOriginInit);
    static encode(origin: ManagedOrigin): Uint8Array;
    static decode(bytes: Uint8Array): ManagedOrigin;
    static fromData(payload: JsonValue): ManagedOrigin;
    equals(other: ManagedOrigin): boolean;
    toData(): JsonValue;
}
