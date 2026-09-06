import type { TransientContentAccess } from "../content/index.js";
import type { TenantId } from "../identity/index.js";
import type { CommandAuthenticator } from "./authentication.js";
import { type CommandDispatchResult } from "./dispatcher.js";
import { type CommandIngressResult } from "./ingress.js";
import { type TenantBootstrapAnchor, type TenantBootstrapTarget } from "./bootstrap.js";
export interface MemoryTenantBootstrapSnapshot {
    readonly version: 1;
    readonly opaque: unknown;
}
export interface MemoryTenantBootstrapInit<Transport> {
    readonly actor: TenantBootstrapTarget["actor"];
    readonly anchor: TenantBootstrapAnchor;
    readonly authenticator: CommandAuthenticator<Transport>;
    readonly content: TransientContentAccess;
    readonly snapshot?: MemoryTenantBootstrapSnapshot;
}
export declare class MemoryTenantBootstrap<Transport> {
    #private;
    readonly tenantId: TenantId;
    constructor(init: MemoryTenantBootstrapInit<Transport>);
    accept(envelope: Uint8Array, transport: Transport, submittedBytes?: Uint8Array): Promise<CommandIngressResult>;
    dispatch(envelope: Uint8Array, transport: Transport, submittedBytes?: Uint8Array): Promise<CommandDispatchResult>;
    snapshot(): MemoryTenantBootstrapSnapshot;
}
export declare function createMemoryTenantBootstrap<Transport>(init: MemoryTenantBootstrapInit<Transport>): MemoryTenantBootstrap<Transport>;
