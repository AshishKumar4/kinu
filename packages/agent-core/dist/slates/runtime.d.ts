import { ContentRef, Revision } from "../core/index.js";
import type { BindingRequirement } from "../facets/index.js";
import { EnvironmentSessionCapability, PortExposureId } from "../environments/index.js";
import { WorkspaceId } from "../identity/index.js";
import { ReceiptId } from "../invocation-references/index.js";
import { SlateDeployment } from "./deployment.js";
import { SlateDeploymentId, SlateId, SlatePreviewId, SlatePublicationId, SlateResourceId, SlateVersionId } from "./id.js";
import { SlatePreview } from "./preview.js";
import { SlateProvider } from "./provider.js";
import { SlatePublication } from "./publication.js";
import { SlateResource } from "./resource.js";
import { SlateInvocationSeam, SlateMutationSeam, SlatePreviewValidationSeam } from "./seams.js";
import { Slate } from "./slate.js";
import { SlateSkeleton } from "./skeleton.js";
import { SlateStore } from "./store.js";
import { SlateVersion } from "./version.js";
export declare abstract class SlateIdSource {
    abstract allocateSlateId(): SlateId;
    abstract allocateVersionId(): SlateVersionId;
    abstract allocatePublicationId(): SlatePublicationId;
    abstract allocateDeploymentId(): SlateDeploymentId;
    abstract allocateResourceId(): SlateResourceId;
    abstract allocatePreviewId(): SlatePreviewId;
}
export declare class MemorySlateIdSource extends SlateIdSource {
    #private;
    private readonly prefix;
    constructor(prefix?: string);
    allocateSlateId(): SlateId;
    allocateVersionId(): SlateVersionId;
    allocatePublicationId(): SlatePublicationId;
    allocateDeploymentId(): SlateDeploymentId;
    allocateResourceId(): SlateResourceId;
    allocatePreviewId(): SlatePreviewId;
    private value;
}
export type SlateDeploymentOutcome = {
    readonly outcome: "succeeded";
    readonly deployment: SlateDeployment;
    readonly receiptId: ReceiptId;
    readonly activated: boolean;
} | {
    readonly outcome: "failed" | "indeterminate";
    readonly deploymentId: SlateDeploymentId;
    readonly receiptId: ReceiptId;
};
export type SlateResourceOutcome = {
    readonly outcome: "succeeded";
    readonly resource: SlateResource;
    readonly receiptId: ReceiptId;
} | {
    readonly outcome: "failed" | "indeterminate";
    readonly resourceId: SlateResourceId;
    readonly receiptId: ReceiptId;
};
/**
 * What admitting a skeleton produces: the new Slate, and every capability the skeleton
 * declared, still unsatisfied. The set is total rather than filtered because instantiate
 * resolves nothing — a caller that receives an empty `unsatisfied` learns the skeleton
 * declared no requirements, never that instantiate bound any.
 */
export interface SlateInstantiation {
    readonly slate: Slate;
    readonly unsatisfied: readonly BindingRequirement[];
}
export declare class SlateRuntime {
    private readonly store;
    private readonly provider;
    private readonly mutations;
    private readonly invocations;
    private readonly previewValidation;
    private readonly ids;
    constructor(store: SlateStore, provider: SlateProvider, mutations: SlateMutationSeam, invocations: SlateInvocationSeam, previewValidation: SlatePreviewValidationSeam, ids: SlateIdSource);
    create(workspaceId: WorkspaceId, source: ContentRef): Promise<Slate>;
    update(id: SlateId, source: ContentRef, expectedRevision?: Revision): Promise<Slate>;
    commit(id: SlateId, expectedRevision?: Revision): Promise<SlateVersion>;
    fork(sourceVersionId: SlateVersionId, workspaceId: WorkspaceId): Promise<Slate>;
    /**
     * The credential-free export of a published Slate (SPEC §4.6). This reads records and
     * mints nothing, so its impact is `observe` and it needs no mutation intent. What it
     * projects is exactly the publication's declared requirements plus the content
     * identity of the version that was published — never the Workspace, never the Slate
     * id, and never a resolvable reference, because a skeleton names no Scope it came from
     * and confers no reach into one.
     */
    exportSkeleton(publicationId: SlatePublicationId): SlateSkeleton;
    /**
     * Admits a skeleton into `workspaceId` as a new Slate. Separate from `fork` because a
     * fork's `forkedFrom` is lineage inside one Workspace and an instantiate crosses a
     * Scope boundary: conflating them would let a lineage edge name a version the
     * admitting Scope does not hold, which is what `verifySlateClosure` rejects.
     *
     * `source` is the importer's own ContentRef for the bytes they were handed, so the
     * only retainer edge this creates is inside their own Scope. The digest comparison is
     * what makes the skeleton's content identity load-bearing rather than decorative.
     *
     * Every requirement the skeleton declares comes back unsatisfied, because admitting a
     * declaration grants nothing. The importer supplies Bindings through §3.4 and §4.1 as
     * for any other Facet; this Operation opens no path of its own.
     */
    instantiate(skeleton: SlateSkeleton, workspaceId: WorkspaceId, source: ContentRef): Promise<SlateInstantiation>;
    publish(versionId: SlateVersionId, materialization: ContentRef, bindings: readonly BindingRequirement[]): Promise<SlatePublication>;
    deploy(publicationId: SlatePublicationId, target: string, externalKey: string): Promise<SlateDeploymentOutcome>;
    reconcileDeployment(id: SlateDeploymentId): Promise<SlateDeploymentOutcome>;
    materializeResource(deploymentId: SlateDeploymentId, name: string, source: ContentRef): Promise<SlateResourceOutcome>;
    reconcileResource(id: SlateResourceId): Promise<SlateResourceOutcome>;
    linkPreview(slateId: SlateId, capability: EnvironmentSessionCapability, exposureId: PortExposureId, versionId?: SlateVersionId): Promise<SlatePreview>;
    rollback(slateId: SlateId, deploymentId: SlateDeploymentId, expectedActiveDeploymentId?: SlateDeploymentId): Promise<Slate>;
    private finalizeDeployment;
    private finalizeResource;
    private mutate;
    private requireSlate;
    private requireExpectedSlate;
    private requireVersion;
    private requirePublication;
    private requireDeployment;
}
