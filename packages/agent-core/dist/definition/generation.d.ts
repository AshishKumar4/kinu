import { ActorRef } from "../actors/index.js";
import { Digest, RecordCodec, Revision, type JsonValue } from "../core/index.js";
import { ManagedOrigin } from "./origin.js";
import type { ActorPlan, DesiredProjection } from "./plan.js";
import { DeploymentId, MaterializationGenerationId } from "./id.js";
export interface ManagedStateRecordInit {
    readonly actor: ActorRef;
    readonly origin: ManagedOrigin;
    readonly generationId: MaterializationGenerationId;
    readonly logicalKey: string;
    readonly recordKind: string;
    readonly desired: JsonValue;
    readonly desiredDigest?: Digest;
    readonly resourceId?: Digest;
    readonly id?: Digest;
}
export declare class ManagedStateRecord {
    static get codec(): RecordCodec<ManagedStateRecord>;
    static supportedRecordKinds(): readonly string[];
    readonly id: Digest;
    readonly resourceId: Digest;
    readonly actor: ActorRef;
    readonly origin: ManagedOrigin;
    readonly generationId: MaterializationGenerationId;
    readonly logicalKey: string;
    readonly recordKind: string;
    readonly desired: JsonValue;
    readonly desiredDigest: Digest;
    constructor(init: ManagedStateRecordInit);
    static fromProjection(actor: ActorRef, origin: ManagedOrigin, generationId: MaterializationGenerationId, projection: DesiredProjection): ManagedStateRecord;
    static encode(record: ManagedStateRecord): Uint8Array;
    static decode(bytes: Uint8Array): ManagedStateRecord;
    static fromData(payload: JsonValue): ManagedStateRecord;
    toData(): JsonValue;
}
export interface MaterializationGenerationInit {
    readonly actor: ActorRef;
    readonly origin: ManagedOrigin;
    readonly actorPlanId: Digest;
    readonly managedRecordIds: readonly Digest[];
    readonly id?: MaterializationGenerationId;
}
export declare class MaterializationGeneration {
    static get codec(): RecordCodec<MaterializationGeneration>;
    readonly id: MaterializationGenerationId;
    readonly actor: ActorRef;
    readonly origin: ManagedOrigin;
    readonly actorPlanId: Digest;
    readonly managedRecordIds: readonly Digest[];
    constructor(init: MaterializationGenerationInit);
    static fromActorPlan(plan: ActorPlan): MaterializationGeneration;
    static encode(generation: MaterializationGeneration): Uint8Array;
    static decode(bytes: Uint8Array): MaterializationGeneration;
    static fromData(payload: JsonValue): MaterializationGeneration;
    toData(): JsonValue;
}
export interface MaterializationGenerationPointerInit {
    readonly actor: ActorRef;
    readonly deploymentId: DeploymentId;
    readonly generationId: MaterializationGenerationId;
    readonly revision: Revision;
}
export declare class MaterializationGenerationPointer {
    static get codec(): RecordCodec<MaterializationGenerationPointer>;
    readonly actor: ActorRef;
    readonly deploymentId: DeploymentId;
    readonly generationId: MaterializationGenerationId;
    readonly revision: Revision;
    constructor(init: MaterializationGenerationPointerInit);
    static initial(actor: ActorRef, deploymentId: DeploymentId, generationId: MaterializationGenerationId): MaterializationGenerationPointer;
    activate(generationId: MaterializationGenerationId): MaterializationGenerationPointer;
    static encode(pointer: MaterializationGenerationPointer): Uint8Array;
    static decode(bytes: Uint8Array): MaterializationGenerationPointer;
    static fromData(payload: JsonValue): MaterializationGenerationPointer;
    toData(): JsonValue;
}
export declare function materializationGenerationId(actor: ActorRef, origin: ManagedOrigin, actorPlanId: Digest): MaterializationGenerationId;
export declare function managedResourceId(actor: ActorRef, origin: ManagedOrigin, logicalKey: string, recordKind: string): Digest;
export declare function managedStateRecordId(actor: ActorRef, generationId: MaterializationGenerationId, resourceId: Digest, desiredDigest: Digest): Digest;
