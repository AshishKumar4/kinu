import { RecordCodec } from "../core/index.js";
import { PrincipalId, TenantId } from "./id.js";
export declare class PrincipalRef {
    readonly tenantId: TenantId;
    readonly principalId: PrincipalId;
    static get codec(): RecordCodec<PrincipalRef>;
    constructor(tenantId: TenantId, principalId: PrincipalId);
    static encode(reference: PrincipalRef): Uint8Array;
    static decode(bytes: Uint8Array): PrincipalRef;
    equals(other: PrincipalRef): boolean;
}
