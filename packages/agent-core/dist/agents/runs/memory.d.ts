import { type ActorRef } from "../../actors/index.js";
import { type MemoryContentSnapshot } from "../../content/index.js";
import type { TenantId } from "../../identity/index.js";
import { RunStoragePort, type RunTransaction, type StoredRunParent, type StoredRunRecord } from "./store.js";
export interface MemoryRunStorageSnapshot {
    readonly version: 2;
    readonly records: readonly StoredRunRecord[];
    readonly parents: readonly StoredRunParent[];
    readonly content: MemoryContentSnapshot;
}
export declare class MemoryRunStorage extends RunStoragePort<RunTransaction> {
    #private;
    constructor(tenant: TenantId, owner: ActorRef, snapshot?: MemoryRunStorageSnapshot, now?: () => Date);
    snapshot(): MemoryRunStorageSnapshot;
}
