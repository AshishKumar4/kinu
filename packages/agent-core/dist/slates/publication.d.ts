import { ContentRef, type ContentRetentionField, type JsonValue, RecordCodec } from "../core/index.js";
import { BindingRequirement } from "../facets/index.js";
import { WorkspaceId } from "../identity/index.js";
import { SlateId, SlatePublicationId, SlateVersionId } from "./id.js";
export declare class SlatePublication {
    readonly id: SlatePublicationId;
    readonly workspaceId: WorkspaceId;
    readonly slateId: SlateId;
    readonly versionId: SlateVersionId;
    readonly materialization: ContentRef;
    static get codec(): RecordCodec<SlatePublication>;
    constructor(id: SlatePublicationId, workspaceId: WorkspaceId, slateId: SlateId, versionId: SlateVersionId, materialization: ContentRef, bindings: readonly BindingRequirement[]);
    /**
     * The capabilities this published Slate needs bound before it can run, declared by
     * name at publish. A declaration, never a grant: it is what a skeleton export carries
     * so a forker can read what the Slate requires before anything of theirs runs.
     */
    readonly bindings: readonly BindingRequirement[];
    static encode(publication: SlatePublication): Uint8Array;
    static decode(bytes: Uint8Array): SlatePublication;
    toData(): JsonValue;
    static fromData(payload: JsonValue): SlatePublication;
}
/**
 * The immutable publication bundle a deployment is cut from (§8.4).
 */
export declare function slatePublicationContentRetention(value: SlatePublication): readonly ContentRetentionField[];
