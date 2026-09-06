import { ContentRef, type JsonValue, RecordCodec, Revision } from "../core/index.js";
import { type ContentCustodyPort } from "../content/index.js";
import { WorkspaceId } from "../identity/index.js";
import { InvocationId } from "../interaction-references/index.js";
import { SlateDeployment } from "./deployment.js";
import { SlateDeploymentId, SlateId, SlatePublicationId, SlateResourceId } from "./id.js";
import { SlatePreview } from "./preview.js";
import { SlatePublication } from "./publication.js";
import { SlateResource } from "./resource.js";
import { Slate } from "./slate.js";
import { SlateVersion } from "./version.js";
export interface SlateDeploymentReservationInit {
    readonly id: SlateDeploymentId;
    readonly workspaceId: WorkspaceId;
    readonly slateId: SlateId;
    readonly publicationId: SlatePublicationId;
    readonly publicationMaterialization: ContentRef;
    readonly target: string;
    readonly invocationId: InvocationId;
    /**
     * The canonical effect identity of the facet-level invocation that requested this
     * deployment. Deploy consults it before reserving, so a crash-after-send retry
     * reconciles the existing reservation instead of minting a second deployment.
     */
    readonly externalKey: string;
    readonly expectedActiveDeploymentId?: SlateDeploymentId;
}
export declare class SlateDeploymentReservation {
    static get codec(): RecordCodec<SlateDeploymentReservation>;
    readonly target: string;
    static encode(reservation: SlateDeploymentReservation): Uint8Array;
    static decode(bytes: Uint8Array): SlateDeploymentReservation;
    constructor(init: SlateDeploymentReservationInit);
    readonly id: SlateDeploymentId;
    readonly workspaceId: WorkspaceId;
    readonly slateId: SlateId;
    readonly publicationId: SlatePublicationId;
    readonly publicationMaterialization: ContentRef;
    readonly invocationId: InvocationId;
    readonly externalKey: string;
    readonly expectedActiveDeploymentId: SlateDeploymentId | undefined;
    toData(): JsonValue;
    static fromData(payload: JsonValue): SlateDeploymentReservation;
}
export interface SlateResourceReservationInit {
    readonly id: SlateResourceId;
    readonly workspaceId: WorkspaceId;
    readonly slateId: SlateId;
    readonly deploymentId: SlateDeploymentId;
    readonly deploymentMaterialization: ContentRef;
    readonly name: string;
    readonly source: ContentRef;
    readonly invocationId: InvocationId;
}
export declare class SlateResourceReservation {
    static get codec(): RecordCodec<SlateResourceReservation>;
    readonly name: string;
    static encode(reservation: SlateResourceReservation): Uint8Array;
    static decode(bytes: Uint8Array): SlateResourceReservation;
    constructor(init: SlateResourceReservationInit);
    readonly id: SlateResourceId;
    readonly workspaceId: WorkspaceId;
    readonly slateId: SlateId;
    readonly deploymentId: SlateDeploymentId;
    readonly deploymentMaterialization: ContentRef;
    readonly source: ContentRef;
    readonly invocationId: InvocationId;
    toData(): JsonValue;
    static fromData(payload: JsonValue): SlateResourceReservation;
}
export interface StoredSlate {
    readonly id: string;
    readonly workspaceId: WorkspaceId;
    readonly revision: number;
    readonly bytes: Uint8Array;
}
export interface StoredSlateRecord {
    readonly id: string;
    readonly workspaceId: WorkspaceId;
    readonly slateId: SlateId;
    readonly bytes: Uint8Array;
}
export interface StoredSlateReservation extends StoredSlateRecord {
    readonly invocationId: InvocationId;
}
export interface MemorySlateSnapshot {
    readonly slates: readonly StoredSlate[];
    readonly versions: readonly StoredSlateRecord[];
    readonly publications: readonly StoredSlateRecord[];
    readonly deployments: readonly StoredSlateRecord[];
    readonly resources: readonly StoredSlateRecord[];
    readonly previews: readonly StoredSlateRecord[];
    readonly deploymentReservations: readonly StoredSlateReservation[];
    readonly resourceReservations: readonly StoredSlateReservation[];
}
/**
 * The custody seam the Slate Actor's store registers its content through (§8.4). The Slate
 * plane has no transaction of its own to join — a write is one call — so the store is the
 * token a custody implementation receives, and registration happens before the row is
 * installed: a refused registration must leave no row behind, while a refused row install
 * may leave a hold nothing names, which collection tolerates and lost content does not.
 */
export type SlateContentCustody = ContentCustodyPort<SlateStore>;
export declare abstract class SlateStore {
    abstract transaction<Result>(operation: (store: SlateStore) => Result): Result;
    abstract getSlate(id: SlateId): Slate | undefined;
    abstract listSlates(workspaceId?: WorkspaceId): readonly Slate[];
    abstract getSlateRevision(id: SlateId, revision: Revision): Slate | undefined;
    abstract listSlateHistory(id: SlateId): readonly Slate[];
    abstract compareAndSetSlate(expected: Revision | undefined, next: Slate): boolean;
    abstract addVersion(version: SlateVersion): void;
    abstract getVersion(id: import("./id.js").SlateVersionId): SlateVersion | undefined;
    abstract listVersions(slateId: SlateId): readonly SlateVersion[];
    abstract addPublication(publication: SlatePublication): void;
    abstract getPublication(id: SlatePublicationId): SlatePublication | undefined;
    abstract listPublications(slateId: SlateId): readonly SlatePublication[];
    abstract addDeployment(deployment: SlateDeployment): void;
    abstract getDeployment(id: SlateDeploymentId): SlateDeployment | undefined;
    abstract listDeployments(slateId: SlateId): readonly SlateDeployment[];
    abstract addResource(resource: SlateResource): void;
    abstract getResource(id: SlateResourceId): SlateResource | undefined;
    abstract listResources(deploymentId: SlateDeploymentId): readonly SlateResource[];
    abstract addPreview(preview: SlatePreview): void;
    abstract getPreview(id: import("./id.js").SlatePreviewId): SlatePreview | undefined;
    abstract listPreviews(slateId: SlateId): readonly SlatePreview[];
    abstract reserveDeployment(reservation: SlateDeploymentReservation): void;
    abstract getDeploymentReservation(id: SlateDeploymentId): SlateDeploymentReservation | undefined;
    abstract findDeploymentReservationByExternalKey(externalKey: string): SlateDeploymentReservation | undefined;
    abstract reserveResource(reservation: SlateResourceReservation): void;
    abstract getResourceReservation(id: SlateResourceId): SlateResourceReservation | undefined;
}
export declare class MemorySlateStore extends SlateStore {
    #private;
    constructor(custody: SlateContentCustody, snapshot?: MemorySlateSnapshot);
    /**
     * A draft holds its custody registrations back until the draft's records commit, so a
     * faulted operation leaves neither a Slate row nor an owner edge behind.
     */
    transaction<Result>(operation: (store: SlateStore) => Result): Result;
    getSlate(id: SlateId): Slate | undefined;
    listSlates(workspaceId_?: WorkspaceId): readonly Slate[];
    getSlateRevision(id: SlateId, revision_: Revision): Slate | undefined;
    listSlateHistory(id: SlateId): readonly Slate[];
    compareAndSetSlate(expected: Revision | undefined, next: Slate): boolean;
    addVersion(version: SlateVersion): void;
    getVersion(id: import("./id.js").SlateVersionId): SlateVersion | undefined;
    listVersions(slateId_: SlateId): readonly SlateVersion[];
    addPublication(publication: SlatePublication): void;
    getPublication(id: SlatePublicationId): SlatePublication | undefined;
    listPublications(slateId_: SlateId): readonly SlatePublication[];
    addDeployment(deployment: SlateDeployment): void;
    getDeployment(id: SlateDeploymentId): SlateDeployment | undefined;
    listDeployments(slateId_: SlateId): readonly SlateDeployment[];
    addResource(resource: SlateResource): void;
    getResource(id: SlateResourceId): SlateResource | undefined;
    listResources(deploymentId_: SlateDeploymentId): readonly SlateResource[];
    addPreview(preview: SlatePreview): void;
    getPreview(id: import("./id.js").SlatePreviewId): SlatePreview | undefined;
    listPreviews(slateId_: SlateId): readonly SlatePreview[];
    reserveDeployment(reservation: SlateDeploymentReservation): void;
    getDeploymentReservation(id: SlateDeploymentId): SlateDeploymentReservation | undefined;
    findDeploymentReservationByExternalKey(externalKey: string): SlateDeploymentReservation | undefined;
    reserveResource(reservation: SlateResourceReservation): void;
    getResourceReservation(id: SlateResourceId): SlateResourceReservation | undefined;
    snapshot(): MemorySlateSnapshot;
    /**
     * A clone reads the same durable state and therefore holds the same custody: a copy is
     * a second reader of one Slate Actor's records, never a second retainer.
     */
    clone(): MemorySlateStore;
    /**
     * Registers a record's ContentRefs before its row is installed. Slate records are
     * immutable once written and every revision is kept, so this store never releases:
     * a superseded head keeps the source its own revision still names.
     */
    private register;
    private restore;
    private install;
    private requireOwned;
    private verifySlateClosure;
    private installSlateRows;
    private verifyAll;
}
