import { RecordCodec, Revision } from "../core/index.js";
import { TenantId } from "./id.js";
export type TenantKind = "personal" | "organization" | "service";
export type TenantStatus = "active" | "suspended" | "deleted";
export declare class Tenant {
    #private;
    readonly id: TenantId;
    readonly kind: TenantKind;
    readonly authorizationRevision: Revision;
    static get codec(): RecordCodec<Tenant>;
    constructor(id: TenantId, kind: TenantKind, status: TenantStatus, authorizationRevision: Revision);
    static encode(tenant: Tenant): Uint8Array;
    static decode(bytes: Uint8Array): Tenant;
    get acceptsMutation(): boolean;
    get status(): TenantStatus;
    revise(status: TenantStatus): Tenant;
}
