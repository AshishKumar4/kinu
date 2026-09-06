import { ContentRef, type ContentRetentionField, type JsonValue, RecordCodec, Revision } from "../core/index.js";
import { EnvironmentId, EnvironmentSessionCapability, EnvironmentSessionId, PortExposureId } from "../environments/index.js";
import { WorkspaceId } from "../identity/index.js";
import { SlateId, SlatePreviewId, SlateVersionId } from "./id.js";
export declare class SlatePreview {
    readonly id: SlatePreviewId;
    readonly workspaceId: WorkspaceId;
    readonly slateId: SlateId;
    readonly exposureId: PortExposureId;
    readonly source: ContentRef;
    readonly versionId?: SlateVersionId | undefined;
    static get codec(): RecordCodec<SlatePreview>;
    constructor(id: SlatePreviewId, workspaceId: WorkspaceId, slateId: SlateId, capability: EnvironmentSessionCapability, exposureId: PortExposureId, source: ContentRef, versionId?: SlateVersionId | undefined);
    readonly environmentId: EnvironmentId;
    readonly sessionId: EnvironmentSessionId;
    readonly environmentRevision: Revision;
    readonly sessionEpoch: number;
    get capability(): EnvironmentSessionCapability;
    static encode(preview: SlatePreview): Uint8Array;
    static decode(bytes: Uint8Array): SlatePreview;
    toData(): JsonValue;
    static fromData(payload: JsonValue): SlatePreview;
}
/**
 * The exact source a preview was built from (§8.4).
 */
export declare function slatePreviewContentRetention(value: SlatePreview): readonly ContentRetentionField[];
