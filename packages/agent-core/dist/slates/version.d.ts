import { ContentRef, type ContentRetentionField, type JsonValue, RecordCodec } from "../core/index.js";
import { WorkspaceId } from "../identity/index.js";
import { SlateId, SlateVersionId } from "./id.js";
export interface SlateVersionInit {
    readonly id: SlateVersionId;
    readonly workspaceId: WorkspaceId;
    readonly slateId: SlateId;
    readonly source: ContentRef;
    readonly parentVersionId?: SlateVersionId;
}
export declare class SlateVersion {
    readonly id: SlateVersionId;
    readonly workspaceId: WorkspaceId;
    readonly slateId: SlateId;
    readonly source: ContentRef;
    readonly parentVersionId?: SlateVersionId | undefined;
    static get codec(): RecordCodec<SlateVersion>;
    constructor(id: SlateVersionId, workspaceId: WorkspaceId, slateId: SlateId, source: ContentRef, parentVersionId?: SlateVersionId | undefined);
    static encode(version: SlateVersion): Uint8Array;
    static decode(bytes: Uint8Array): SlateVersion;
    toData(): JsonValue;
    static fromData(payload: JsonValue): SlateVersion;
}
/**
 * A committed version's frozen source (§8.4). Versions are immutable, so this retention is
 * owed on write and never released while the version stands.
 */
export declare function slateVersionContentRetention(value: SlateVersion): readonly ContentRetentionField[];
