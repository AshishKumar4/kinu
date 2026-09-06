import { type ActorRef } from "../../actors/index.js";
import type { TransientContentAccess } from "../../content/index.js";
import type { TenantId } from "../../identity/index.js";
import { type CommandAuthenticator, type CommandDispatchResult, type CommandIngressResult, type TenantBootstrapAnchor } from "../../protocol/index.js";
import { TransactionalSqlite } from "./sqlite.js";
export interface SqliteTenantBootstrapInit<Transport> {
    readonly actor: ActorRef;
    readonly anchor?: TenantBootstrapAnchor;
    readonly authenticator: CommandAuthenticator<Transport>;
    readonly content: TransientContentAccess;
    readonly database: TransactionalSqlite;
}
export declare class SqliteTenantBootstrap<Transport> {
    #private;
    readonly tenantId: TenantId;
    constructor(init: SqliteTenantBootstrapInit<Transport>);
    accept(envelope: Uint8Array, transport: Transport, submittedBytes?: Uint8Array): Promise<CommandIngressResult>;
    dispatch(envelope: Uint8Array, transport: Transport, submittedBytes?: Uint8Array): Promise<CommandDispatchResult>;
}
export declare function createSqliteTenantBootstrap<Transport>(init: SqliteTenantBootstrapInit<Transport>): SqliteTenantBootstrap<Transport>;
