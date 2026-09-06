import { ActorRef } from "../actors/index.js";
import { Digest, RecordCodec, type JsonValue } from "../core/index.js";
import { ManagedOrigin } from "./origin.js";
import { PlacementSelection } from "./placement.js";
import { PolicySet } from "./policy.js";
import { ValidatedBlueprint } from "./validator.js";
import { TenantId } from "../identity/index.js";
import { DeploymentKey } from "./id.js";
export interface DesiredProjectionInit {
    readonly logicalKey: string;
    readonly recordKind: string;
    readonly desired: JsonValue;
    readonly desiredDigest?: Digest;
}
export declare class DesiredProjection {
    readonly logicalKey: string;
    readonly recordKind: string;
    readonly desired: JsonValue;
    readonly desiredDigest: Digest;
    constructor(init: DesiredProjectionInit);
    static fromData(payload: JsonValue): DesiredProjection;
    toData(): JsonValue;
}
export declare function placementProjection(logicalKey: string, facet: string, selection: PlacementSelection): DesiredProjection;
export declare function policyProjection(logicalKey: string, policy: PolicySet): DesiredProjection;
export interface ActorPlanInit {
    readonly actor: ActorRef;
    readonly origin: ManagedOrigin;
    readonly projections: readonly DesiredProjection[];
    readonly id?: Digest;
}
export declare class ActorPlan {
    static get codec(): RecordCodec<ActorPlan>;
    readonly id: Digest;
    readonly actor: ActorRef;
    readonly origin: ManagedOrigin;
    readonly projections: readonly DesiredProjection[];
    constructor(init: ActorPlanInit);
    static encode(plan: ActorPlan): Uint8Array;
    static decode(bytes: Uint8Array): ActorPlan;
    static fromData(payload: JsonValue): ActorPlan;
    toData(): JsonValue;
}
export interface MaterializationPlanInit {
    readonly origin: ManagedOrigin;
    readonly actors: readonly ActorPlan[];
    readonly id?: Digest;
}
export declare class MaterializationPlan {
    static get codec(): RecordCodec<MaterializationPlan>;
    readonly id: Digest;
    readonly origin: ManagedOrigin;
    readonly actors: readonly ActorPlan[];
    constructor(init: MaterializationPlanInit);
    get blueprintDigest(): Digest;
    get packageLockDigest(): Digest;
    get configDigest(): Digest;
    get generation(): number;
    static encode(plan: MaterializationPlan): Uint8Array;
    static decode(bytes: Uint8Array): MaterializationPlan;
    static fromData(payload: JsonValue): MaterializationPlan;
    toData(): JsonValue;
}
export declare abstract class MaterializationTopologyPort {
    /**
     * Route a projection to its single owning Actor (SPEC §8.4). Implementations must
     * follow the normative ownership map: policy-set and scope-scaffold records belong
     * to the tenant Actor; facet-install, facet-placement, slot-entry, subscription,
     * agent-profile, and surface-layout records belong to the owning workspace Actor;
     * environment records belong to their environment Actor. Grants and Bindings are
     * authority-plane records materialized outside the definition plane (role
     * assignment and composition policies), never through this port.
     */
    abstract actorFor(validated: ValidatedBlueprint, projection: DesiredProjection): ActorRef;
}
export interface PlanMaterializationInput {
    readonly validatedBlueprint: ValidatedBlueprint;
    readonly tenantId: TenantId;
    readonly deploymentKey: DeploymentKey;
    readonly generation: number;
    readonly topology: MaterializationTopologyPort;
}
export declare function planMaterialization(input: PlanMaterializationInput): MaterializationPlan;
