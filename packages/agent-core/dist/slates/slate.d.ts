import { ContentRef, type ContentRetentionField, type JsonValue, RecordCodec, Revision } from "../core/index.js";
import { WorkspaceId } from "../identity/index.js";
import { SlateDeploymentId, SlateId, SlatePublicationId, SlateVersionId } from "./id.js";
export interface SlateForkRef {
    readonly slateId: SlateId;
    readonly versionId: SlateVersionId;
}
export interface SlateInit {
    readonly id: SlateId;
    readonly workspaceId: WorkspaceId;
    readonly source: ContentRef;
    readonly headVersionId?: SlateVersionId;
    readonly latestPublicationId?: SlatePublicationId;
    readonly activeDeploymentId?: SlateDeploymentId;
    readonly forkedFrom?: SlateForkRef;
    readonly revision: Revision;
}
export declare class Slate {
    static get codec(): RecordCodec<Slate>;
    readonly id: SlateId;
    readonly workspaceId: WorkspaceId;
    readonly source: ContentRef;
    readonly headVersionId: SlateVersionId | undefined;
    readonly latestPublicationId: SlatePublicationId | undefined;
    readonly activeDeploymentId: SlateDeploymentId | undefined;
    readonly forkedFrom: SlateForkRef | undefined;
    readonly revision: Revision;
    constructor(init: SlateInit);
    static initial(id: SlateId, workspaceId_: WorkspaceId, source: ContentRef): Slate;
    update(source: ContentRef): Slate;
    commit(version: SlateVersionId): Slate;
    publish(publication: SlatePublicationId): Slate;
    selectDeployment(deployment: SlateDeploymentId | undefined): Slate;
    static encode(slate: Slate): Uint8Array;
    static decode(bytes: Uint8Array): Slate;
    toData(): JsonValue;
    static fromData(payload: JsonValue): Slate;
    private revise;
}
/**
 * The Slate head's working source (§8.4). Every revision of a Slate is kept, so a head
 * that advances retains its new source without releasing the source the prior revision
 * still names.
 */
export declare function slateContentRetention(value: Slate): readonly ContentRetentionField[];
