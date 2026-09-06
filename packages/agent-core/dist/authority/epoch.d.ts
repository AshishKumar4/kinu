import { ActorRef } from "../actors/index.js";
import { type JsonValue, RecordCodec, Revision } from "../core/index.js";
import { PrincipalRef, ScopeRef, TenantId } from "../identity/index.js";
import { type JsonObject } from "./data.js";
export declare class ScopeEpoch {
    readonly scope: ScopeRef;
    readonly epoch: number;
    static get codec(): RecordCodec<ScopeEpoch>;
    constructor(scope: ScopeRef, epoch: number);
    static initial(scope: ScopeRef): ScopeEpoch;
    static encode(record: ScopeEpoch): Uint8Array;
    static decode(bytes: Uint8Array): ScopeEpoch;
    next(): ScopeEpoch;
    equals(other: ScopeEpoch): boolean;
    toData(): JsonObject;
    static fromData(value: JsonValue | undefined): ScopeEpoch;
}
export declare class PathEpochEvidence {
    static get codec(): RecordCodec<PathEpochEvidence>;
    readonly path: readonly [ScopeEpoch, ...ScopeEpoch[]];
    constructor(path: readonly [ScopeEpoch, ...ScopeEpoch[]]);
    static encode(record: PathEpochEvidence): Uint8Array;
    static decode(bytes: Uint8Array): PathEpochEvidence;
    get target(): ScopeEpoch;
    equals(other: PathEpochEvidence): boolean;
    staleScopes(current: PathEpochEvidence): readonly ScopeRef[];
    toData(): JsonObject;
    static fromData(value: JsonValue | undefined): PathEpochEvidence;
}
export declare class InvalidationWatermark {
    readonly ownerTenant: TenantId;
    readonly owner: ActorRef;
    readonly holder: PrincipalRef;
    readonly revision: Revision;
    static get codec(): RecordCodec<InvalidationWatermark>;
    readonly delivered: readonly ScopeEpoch[];
    constructor(ownerTenant: TenantId, owner: ActorRef, holder: PrincipalRef, delivered: readonly ScopeEpoch[], revision: Revision);
    static empty(ownerTenant: TenantId, owner: ActorRef, holder: PrincipalRef): InvalidationWatermark;
    static encode(record: InvalidationWatermark): Uint8Array;
    static decode(bytes: Uint8Array): InvalidationWatermark;
    /**
     * A scope this watermark does not carry answers 0, which makes an entry recorded at
     * epoch 0 and an absent entry indistinguishable to every reader. `dominates` depends on
     * that: it compares epochs only, so dropping an epoch-0 entry preserves domination
     * without losing anything observable. A reader that needed to tell "delivered at 0" from
     * "never delivered" would break the guard, and would have to carry that distinction
     * itself rather than infer it from membership.
     */
    epoch(scope: ScopeRef): number;
    join(entries: readonly ScopeEpoch[]): InvalidationWatermark;
    dominates(other: InvalidationWatermark): boolean;
    toData(): JsonObject;
    static fromData(value: JsonValue | undefined): InvalidationWatermark;
}
