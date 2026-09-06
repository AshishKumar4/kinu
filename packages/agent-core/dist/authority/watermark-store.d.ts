import type { ActorRef } from "../actors/index.js";
import type { TenantId } from "../identity/index.js";
import { InvalidationWatermark, type ScopeEpoch } from "./epoch.js";
export interface InvalidationWatermarkStore {
    load(key: string): InvalidationWatermark | undefined;
    save(watermark: InvalidationWatermark): void;
    join(key: string, entries: readonly ScopeEpoch[]): InvalidationWatermark;
}
export interface MemoryInvalidationWatermarkSnapshot {
    readonly version: 1;
    readonly records: readonly {
        readonly key: string;
        readonly bytes: Uint8Array;
    }[];
}
export declare class MemoryInvalidationWatermarkStore implements InvalidationWatermarkStore {
    #private;
    private readonly ownerTenant;
    private readonly owner;
    constructor(ownerTenant: TenantId, owner: ActorRef, snapshot?: MemoryInvalidationWatermarkSnapshot);
    load(key: string): InvalidationWatermark | undefined;
    save(watermark: InvalidationWatermark): void;
    join(key: string, entries: readonly ScopeEpoch[]): InvalidationWatermark;
    snapshot(): MemoryInvalidationWatermarkSnapshot;
}
export declare function watermarkKey(watermark: InvalidationWatermark): string;
