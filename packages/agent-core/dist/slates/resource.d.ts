import { ContentRef, type ContentRetentionField, type JsonValue, RecordCodec } from "../core/index.js";
import { WorkspaceId } from "../identity/index.js";
import { InvocationId } from "../interaction-references/index.js";
import { ReceiptId } from "../invocation-references/index.js";
import { SlateDeploymentId, SlateId, SlateResourceId } from "./id.js";
export declare class SlateResource {
    readonly id: SlateResourceId;
    readonly workspaceId: WorkspaceId;
    readonly slateId: SlateId;
    readonly deploymentId: SlateDeploymentId;
    readonly source: ContentRef;
    readonly materialization: ContentRef;
    readonly invocationId: InvocationId;
    readonly receiptId: ReceiptId;
    static get codec(): RecordCodec<SlateResource>;
    readonly name: string;
    constructor(id: SlateResourceId, workspaceId: WorkspaceId, slateId: SlateId, deploymentId: SlateDeploymentId, name: string, source: ContentRef, materialization: ContentRef, invocationId: InvocationId, receiptId: ReceiptId);
    static encode(resource: SlateResource): Uint8Array;
    static decode(bytes: Uint8Array): SlateResource;
    toData(): JsonValue;
    static fromData(payload: JsonValue): SlateResource;
}
/**
 * A provisioned resource's source and its materialization (§8.4). Both are named by the
 * record, so both are held for as long as the resource row stands.
 */
export declare function slateResourceContentRetention(value: SlateResource): readonly ContentRetentionField[];
