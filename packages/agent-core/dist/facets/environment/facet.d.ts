import type { LeaseToken } from "../../agents/index.js";
import { ContentRef, SecretRef } from "../../core/index.js";
import { EnvironmentController, EnvironmentId, EnvironmentSessionId, EnvironmentSnapshotId, PortExposureId, type EnvironmentSession, type EnvironmentSessionCapability } from "../../environments/index.js";
import { Contributions, type OperationDescriptor } from "../contribution.js";
import type { FacetManifest } from "../manifest.js";
import { InternalProfileFacetRuntime, ProfileControlContract, type ProtectedProfileRuntimePort, type PublicProfileInput } from "../profile-runtime/index.js";
export declare const ENVIRONMENT_OPERATIONS: readonly OperationDescriptor[];
export declare const ENVIRONMENT_EVENTS: readonly never[];
export declare const ENVIRONMENT_CONTRIBUTIONS: Contributions;
export interface EnvironmentOpenInput extends PublicProfileInput {
    readonly environment: string;
    readonly restoreFrom?: string;
}
export interface EnvironmentSessionInput extends PublicProfileInput {
    readonly session: string;
}
export interface EnvironmentSnapshotInput extends PublicProfileInput {
    readonly session: string;
    readonly snapshot: string;
}
export interface EnvironmentRestoreInput extends PublicProfileInput {
    readonly environment: string;
    readonly snapshot: string;
}
export interface EnvironmentPreviewInput extends PublicProfileInput {
    readonly session: string;
    readonly port: number;
}
export interface EnvironmentCredentialInput extends PublicProfileInput {
    readonly session: string;
    readonly credential: SecretRef;
    readonly request: ContentRef;
}
export declare class EnvironmentSessionBinding {
    readonly session: string;
    readonly generation: number;
    readonly children: readonly string[];
    constructor(session: string, generation: number, children: readonly string[]);
}
export declare abstract class EnvironmentBackend {
    abstract open(input: EnvironmentOpenInput): Promise<EnvironmentSessionBinding>;
    abstract use(input: EnvironmentSessionInput): Promise<EnvironmentSessionBinding>;
    abstract close(input: EnvironmentSessionInput): Promise<void>;
    abstract snapshot(input: EnvironmentSnapshotInput): Promise<ContentRef>;
    abstract restore(input: EnvironmentRestoreInput): Promise<EnvironmentSessionBinding>;
    abstract backupEphemeral(input: EnvironmentSessionInput): Promise<ContentRef>;
    abstract restoreEphemeral(input: EnvironmentSnapshotInput): Promise<void>;
    abstract exposePreview(input: EnvironmentPreviewInput): Promise<string>;
    abstract forwardCredential(input: EnvironmentCredentialInput): Promise<ContentRef>;
}
export declare abstract class EnvironmentLeasePort {
    abstract current(): LeaseToken;
}
export declare abstract class EnvironmentIdPort {
    abstract environment(name: string): EnvironmentId;
    abstract allocateSession(environment: EnvironmentId): EnvironmentSessionId;
    abstract capability(session: string): EnvironmentSessionCapability;
    abstract bind(session: EnvironmentSession): void;
    abstract snapshot(name: string): EnvironmentSnapshotId;
    abstract allocateSnapshot(session: EnvironmentSessionCapability): EnvironmentSnapshotId;
    abstract allocateExposure(session: EnvironmentSessionCapability, port: number): PortExposureId;
}
export declare abstract class EnvironmentChildBindingPort {
    abstract bind(session: EnvironmentSession): readonly string[];
    abstract backupEphemeral(capability: EnvironmentSessionCapability, lease: LeaseToken): Promise<ContentRef>;
    abstract restoreEphemeral(capability: EnvironmentSessionCapability, snapshot: EnvironmentSnapshotId, lease: LeaseToken): Promise<void>;
}
export declare abstract class EnvironmentCredentialPort {
    abstract forward(capability: EnvironmentSessionCapability, credential: SecretRef, request: ContentRef): Promise<ContentRef>;
}
export declare abstract class EnvironmentPreviewPort {
    abstract expose(capability: EnvironmentSessionCapability, exposureId: PortExposureId, port: number, lease: LeaseToken): Promise<string>;
}
export declare class EnvironmentControllerPreviewPort extends EnvironmentPreviewPort {
    private readonly controller;
    constructor(controller: EnvironmentController);
    expose(capability: EnvironmentSessionCapability, exposureId: PortExposureId, port: number, lease: LeaseToken): Promise<string>;
}
export declare class EnvironmentControllerBackend extends EnvironmentBackend {
    private readonly controller;
    private readonly leases;
    private readonly ids;
    private readonly children;
    private readonly preview;
    private readonly credentials;
    constructor(controller: EnvironmentController, leases: EnvironmentLeasePort, ids: EnvironmentIdPort, children: EnvironmentChildBindingPort, preview: EnvironmentPreviewPort, credentials: EnvironmentCredentialPort);
    open(input: EnvironmentOpenInput): Promise<EnvironmentSessionBinding>;
    use(input: EnvironmentSessionInput): Promise<EnvironmentSessionBinding>;
    close(input: EnvironmentSessionInput): Promise<void>;
    snapshot(input: EnvironmentSnapshotInput): Promise<ContentRef>;
    restore(input: EnvironmentRestoreInput): Promise<EnvironmentSessionBinding>;
    backupEphemeral(input: EnvironmentSessionInput): Promise<ContentRef>;
    restoreEphemeral(input: EnvironmentSnapshotInput): Promise<void>;
    exposePreview(input: EnvironmentPreviewInput): Promise<string>;
    forwardCredential(input: EnvironmentCredentialInput): Promise<ContentRef>;
    private binding;
}
export declare const ENVIRONMENT_CONTROL_CONTRACTS: Readonly<{
    open: ProfileControlContract<"environment.open", EnvironmentOpenInput, EnvironmentSessionBinding>;
    use: ProfileControlContract<"environment.use", EnvironmentSessionInput, EnvironmentSessionBinding>;
    close: ProfileControlContract<"environment.close", EnvironmentSessionInput, void>;
    snapshot: ProfileControlContract<"environment.snapshot", EnvironmentSnapshotInput, ContentRef>;
    restore: ProfileControlContract<"environment.restore", EnvironmentRestoreInput, EnvironmentSessionBinding>;
    backupEphemeral: ProfileControlContract<"environment.backupEphemeral", EnvironmentSessionInput, ContentRef>;
    restoreEphemeral: ProfileControlContract<"environment.restoreEphemeral", EnvironmentSnapshotInput, void>;
    exposePreview: ProfileControlContract<"environment.exposePreview", EnvironmentPreviewInput, string>;
    forwardCredential: ProfileControlContract<"environment.forwardCredential", EnvironmentCredentialInput, ContentRef>;
}>;
export declare class EnvironmentFacet<Receipt> {
    private readonly runtime;
    private readonly backend;
    static readonly operations: readonly OperationDescriptor[];
    static readonly events: readonly never[];
    constructor(runtime: ProtectedProfileRuntimePort<Receipt>, backend: EnvironmentBackend);
    asInternalRuntime(manifest: FacetManifest): InternalProfileFacetRuntime;
    open(input: EnvironmentOpenInput): Promise<EnvironmentSessionBinding>;
    use(input: EnvironmentSessionInput): Promise<EnvironmentSessionBinding>;
    close(input: EnvironmentSessionInput): Promise<void>;
    snapshot(input: EnvironmentSnapshotInput): Promise<ContentRef>;
    restore(input: EnvironmentRestoreInput): Promise<EnvironmentSessionBinding>;
    backupEphemeral(input: EnvironmentSessionInput): Promise<ContentRef>;
    restoreEphemeral(input: EnvironmentSnapshotInput): Promise<void>;
    exposePreview(input: EnvironmentPreviewInput): Promise<string>;
    forwardCredential(input: EnvironmentCredentialInput): Promise<ContentRef>;
}
