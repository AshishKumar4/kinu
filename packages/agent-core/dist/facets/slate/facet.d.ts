import type { JsonValue } from "../../core/index.js";
import { Contributions, OperationDescriptor, SurfaceDescriptor } from "../contribution.js";
import type { EnvironmentFacet, EnvironmentPreviewInput } from "../environment/index.js";
import type { FacetManifest } from "../manifest.js";
import { ProfileOperationContract, InternalProfileFacetRuntime, type EffectDispatch, type ProtectedProfileRuntimePort, type PublicProfileInput } from "../profile-runtime/index.js";
export interface SlateUpdateInput extends PublicProfileInput {
    readonly slate: string;
    readonly source: string;
    readonly expectedRevision?: number;
}
export interface SlateCommitInput extends PublicProfileInput {
    readonly slate: string;
    readonly expectedRevision?: number;
}
export interface SlateForkInput extends PublicProfileInput {
    readonly sourceVersion: string;
    readonly workspace: string;
}
export interface SlatePublishInput extends PublicProfileInput {
    readonly version: string;
    readonly materialization: string;
}
export interface SlateDeployInput extends PublicProfileInput {
    readonly publication: string;
    readonly target: string;
}
export interface SlateRollbackInput extends PublicProfileInput {
    readonly slate: string;
    readonly deployment: string;
    readonly expectedActiveDeployment?: string;
}
export declare abstract class SlateBackend {
    abstract update(input: SlateUpdateInput): Promise<JsonValue>;
    abstract commit(input: SlateCommitInput): Promise<JsonValue>;
    abstract fork(input: SlateForkInput): Promise<JsonValue>;
    abstract publish(input: SlatePublishInput): Promise<JsonValue>;
    /**
     * Deploys a publication to its target — the profile's one `externalSend` Operation —
     * carrying its canonical effect identity. The provider MUST treat
     * `dispatch.idempotencyKey` as the dedup key for the deployment and MUST be able to
     * answer a reconciliation query addressed by `dispatch.attempt` identity, so a
     * crash-after-send retry neither redeploys nor stays indeterminate (SPEC §7.4).
     */
    abstract deploy(input: SlateDeployInput, dispatch: EffectDispatch): Promise<JsonValue>;
    abstract rollback(input: SlateRollbackInput): Promise<JsonValue>;
}
export declare const SLATE_OPERATION_CONTRACTS: Readonly<{
    update: ProfileOperationContract<"update", SlateUpdateInput, JsonValue, "output">;
    commit: ProfileOperationContract<"commit", SlateCommitInput, JsonValue, "output">;
    fork: ProfileOperationContract<"fork", SlateForkInput, JsonValue, "output">;
    publish: ProfileOperationContract<"publish", SlatePublishInput, JsonValue, "output">;
    deploy: ProfileOperationContract<"deploy", SlateDeployInput, JsonValue, "output">;
    rollback: ProfileOperationContract<"rollback", SlateRollbackInput, JsonValue, "output">;
}>;
export declare const SLATE_OPERATIONS: readonly OperationDescriptor[];
export declare const SLATE_ISOLATION: readonly ["dynamic"];
export declare const SLATE_SURFACES: readonly SurfaceDescriptor[];
export declare const SLATE_CONTRIBUTIONS: Contributions;
export declare class SlateFacet<Receipt> {
    private readonly runtime;
    private readonly backend;
    private readonly environment;
    static readonly operations: readonly OperationDescriptor[];
    static readonly isolation: readonly ["dynamic"];
    static readonly surfaces: readonly SurfaceDescriptor[];
    constructor(runtime: ProtectedProfileRuntimePort<Receipt>, backend: SlateBackend, environment: Pick<EnvironmentFacet<Receipt>, "exposePreview">);
    asInternalRuntime(manifest: FacetManifest): InternalProfileFacetRuntime;
    update(input: SlateUpdateInput): Promise<JsonValue>;
    commit(input: SlateCommitInput): Promise<JsonValue>;
    fork(input: SlateForkInput): Promise<JsonValue>;
    publish(input: SlatePublishInput): Promise<JsonValue>;
    deploy(input: SlateDeployInput): Promise<JsonValue>;
    rollback(input: SlateRollbackInput): Promise<JsonValue>;
    preview(input: EnvironmentPreviewInput): Promise<string>;
}
