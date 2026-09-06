import { ContentRef, Digest, Revision } from "../core/index.js";
import { EnvironmentId, EnvironmentSessionId, PortExposureId } from "../environments/index.js";
import { WorkspaceId } from "../identity/index.js";
import { InvocationId } from "../interaction-references/index.js";
import { ReceiptId } from "../invocation-references/index.js";
import type { BindingRequirement } from "../facets/index.js";
import { SlateDeploymentId, SlateId, SlatePreviewId, SlatePublicationId, SlateResourceId, SlateVersionId } from "./id.js";
interface SlateIntentBase {
    readonly workspaceId: WorkspaceId;
    readonly slateId: SlateId;
}
export interface SlateCreateIntent extends SlateIntentBase {
    readonly operation: "create";
    readonly impact: "mutate";
    readonly source: ContentRef;
}
export interface SlateUpdateIntent extends SlateIntentBase {
    readonly operation: "update";
    readonly impact: "mutate";
    readonly source: ContentRef;
    readonly expectedRevision: Revision;
}
export interface SlateCommitIntent extends SlateIntentBase {
    readonly operation: "commit";
    readonly impact: "mutate";
    readonly versionId: SlateVersionId;
    readonly source: ContentRef;
    readonly parentVersionId: SlateVersionId | undefined;
    readonly expectedRevision: Revision;
}
export interface SlateForkIntent extends SlateIntentBase {
    readonly operation: "fork";
    readonly impact: "mutate";
    readonly sourceSlateId: SlateId;
    readonly sourceVersionId: SlateVersionId;
    readonly source: ContentRef;
    readonly expectedSourceRevision: Revision;
}
/**
 * `instantiate` is the seventh Slate Operation and is deliberately not `fork`. A fork is
 * lineage inside one Workspace, so it carries `sourceSlateId`/`sourceVersionId`; an
 * instantiate is a new Slate in a different Scope built from a credential-free skeleton,
 * and it carries neither. The key set is the enforcement: an instantiate intent naming a
 * source Slate or version is refused as malformed rather than admitted as a cross-Scope
 * fork. `skeletonDigest` pins the exact artifact admitted without copying it.
 */
export interface SlateInstantiateIntent extends SlateIntentBase {
    readonly operation: "instantiate";
    readonly impact: "mutate";
    readonly source: ContentRef;
    readonly skeletonDigest: Digest;
}
export interface SlatePublishIntent extends SlateIntentBase {
    readonly operation: "publish";
    readonly impact: "mutate";
    readonly publicationId: SlatePublicationId;
    readonly versionId: SlateVersionId;
    readonly source: ContentRef;
    readonly materialization: ContentRef;
    /**
     * The capabilities the published Slate declares it needs, canonical and unique by
     * name. Publish is where the declaration is made, so it is part of the recorded intent
     * rather than something the writer derives.
     */
    readonly bindings: readonly BindingRequirement[];
    readonly expectedRevision: Revision;
}
export interface SlateDeployInvocationIntent extends SlateIntentBase {
    readonly operation: "deploy";
    readonly impact: "externalSend";
    readonly deploymentId: SlateDeploymentId;
    readonly publicationId: SlatePublicationId;
    readonly publicationMaterialization: ContentRef;
    readonly target: string;
    readonly expectedActiveDeploymentId: SlateDeploymentId | undefined;
}
export interface SlateResourceInvocationIntent extends SlateIntentBase {
    readonly operation: "resource.materialize";
    readonly impact: "externalSend";
    readonly resourceId: SlateResourceId;
    readonly deploymentId: SlateDeploymentId;
    readonly deploymentMaterialization: ContentRef;
    readonly resourceName: string;
    readonly resourceSource: ContentRef;
}
export type SlateInvocationRequest = SlateDeployInvocationIntent | SlateResourceInvocationIntent;
export interface SlateDeployReserveIntent extends SlateIntentBase {
    readonly operation: "deploy.reserve";
    readonly impact: "mutate";
    readonly deploymentId: SlateDeploymentId;
    readonly publicationId: SlatePublicationId;
    readonly publicationMaterialization: ContentRef;
    readonly target: string;
    readonly expectedActiveDeploymentId: SlateDeploymentId | undefined;
    readonly invocationId: InvocationId;
}
export interface SlateDeployFinalizeIntent extends SlateIntentBase {
    readonly operation: "deploy.finalize";
    readonly impact: "mutate";
    readonly deploymentId: SlateDeploymentId;
    readonly publicationId: SlatePublicationId;
    readonly publicationMaterialization: ContentRef;
    readonly target: string;
    readonly expectedActiveDeploymentId: SlateDeploymentId | undefined;
    readonly invocationId: InvocationId;
    readonly receiptId: ReceiptId;
    readonly materialization: ContentRef;
}
export interface SlateResourceReserveIntent extends SlateIntentBase {
    readonly operation: "resource.reserve";
    readonly impact: "mutate";
    readonly resourceId: SlateResourceId;
    readonly deploymentId: SlateDeploymentId;
    readonly deploymentMaterialization: ContentRef;
    readonly resourceName: string;
    readonly resourceSource: ContentRef;
    readonly invocationId: InvocationId;
}
export interface SlateResourceFinalizeIntent extends SlateIntentBase {
    readonly operation: "resource.finalize";
    readonly impact: "mutate";
    readonly resourceId: SlateResourceId;
    readonly deploymentId: SlateDeploymentId;
    readonly deploymentMaterialization: ContentRef;
    readonly resourceName: string;
    readonly resourceSource: ContentRef;
    readonly invocationId: InvocationId;
    readonly receiptId: ReceiptId;
    readonly materialization: ContentRef;
}
export interface SlatePreviewLinkIntent extends SlateIntentBase {
    readonly operation: "preview.link";
    readonly impact: "mutate";
    readonly previewId: SlatePreviewId;
    readonly source: ContentRef;
    readonly versionId: SlateVersionId | undefined;
    readonly environmentId: EnvironmentId;
    readonly sessionId: EnvironmentSessionId;
    readonly environmentRevision: Revision;
    readonly sessionEpoch: number;
    readonly exposureId: PortExposureId;
    readonly expectedRevision: Revision;
}
export interface SlateRollbackIntent extends SlateIntentBase {
    readonly operation: "rollback";
    readonly impact: "mutate";
    readonly deploymentId: SlateDeploymentId;
    readonly expectedActiveDeploymentId: SlateDeploymentId | undefined;
    readonly expectedRevision: Revision;
}
export type SlateMutationRequest = SlateCreateIntent | SlateUpdateIntent | SlateCommitIntent | SlateForkIntent | SlateInstantiateIntent | SlatePublishIntent | SlateDeployReserveIntent | SlateDeployFinalizeIntent | SlateResourceReserveIntent | SlateResourceFinalizeIntent | SlatePreviewLinkIntent | SlateRollbackIntent;
export type SlateMutationOperation = SlateMutationRequest["operation"];
export type SlateInvocationOperation = SlateInvocationRequest["operation"];
export declare function freezeSlateMutationRequest<Request extends SlateMutationRequest>(request: Request): Readonly<Request>;
export declare function freezeSlateInvocationRequest<Request extends SlateInvocationRequest>(request: Request): Readonly<Request>;
export declare function canonicalSlateMutationRequest(request: SlateMutationRequest): Uint8Array;
export declare function canonicalSlateInvocationRequest(request: SlateInvocationRequest): Uint8Array;
export declare function sameSlateInvocationRequest(left: SlateInvocationRequest, right: SlateInvocationRequest): boolean;
export {};
