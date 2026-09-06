import { ContentRef, type ContentRetentionField, type JsonValue, RecordCodec } from "../core/index.js";
import { WorkspaceId } from "../identity/index.js";
import { InvocationId } from "../interaction-references/index.js";
import { ReceiptId } from "../invocation-references/index.js";
import { SlateDeploymentId, SlateId, SlatePublicationId } from "./id.js";
export declare class SlateDeployment {
    readonly id: SlateDeploymentId;
    readonly workspaceId: WorkspaceId;
    readonly slateId: SlateId;
    readonly publicationId: SlatePublicationId;
    readonly materialization: ContentRef;
    readonly invocationId: InvocationId;
    readonly receiptId: ReceiptId;
    static get codec(): RecordCodec<SlateDeployment>;
    readonly target: string;
    constructor(id: SlateDeploymentId, workspaceId: WorkspaceId, slateId: SlateId, publicationId: SlatePublicationId, target: string, materialization: ContentRef, invocationId: InvocationId, receiptId: ReceiptId);
    static encode(deployment: SlateDeployment): Uint8Array;
    static decode(bytes: Uint8Array): SlateDeployment;
    toData(): JsonValue;
    static fromData(payload: JsonValue): SlateDeployment;
}
/**
 * The materialization a deployment installed (§8.4).
 */
export declare function slateDeploymentContentRetention(value: SlateDeployment): readonly ContentRetentionField[];
