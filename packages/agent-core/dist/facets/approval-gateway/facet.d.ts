import { Digest, type JsonValue } from "../../core/index.js";
import type { InvocationId } from "../../interaction-references/index.js";
import { Contributions, OperationDescriptor, SurfaceDescriptor } from "../contribution.js";
import type { FacetManifest } from "../manifest.js";
import { DetailedProfileError, InternalProfileFacetRuntime, EffectDispatch, ProfileEffectContext, ProfileOperationContract, type ProtectedProfileRuntimePort, type PublicProfileInput } from "../profile-runtime/index.js";
export interface GatewayObservationInput extends PublicProfileInput {
    readonly resource: string;
}
export interface GatewayActionInput extends PublicProfileInput {
    readonly resource: string;
}
export declare class ApprovalGatewayAction {
    readonly invocationId: InvocationId;
    readonly intentDigest: Digest;
    readonly resource: string;
    readonly action: JsonValue;
    constructor(invocationId: InvocationId, intentDigest: Digest, resource: string, action: JsonValue);
    actionFor(context: ProfileEffectContext, resource: string): JsonValue;
}
export declare abstract class ApprovalGatewayBackend {
    abstract observe(resource: string): Promise<JsonValue>;
    abstract apply(dispatch: EffectDispatch, resource: string, action: JsonValue): Promise<JsonValue>;
    abstract reconcile(dispatch: EffectDispatch): Promise<ApprovalGatewayReconciliationResult>;
}
export type ApprovalGatewayReconciliationResult = {
    readonly kind: "unknown";
} | {
    readonly kind: "succeeded";
    readonly result?: JsonValue;
} | {
    readonly kind: "failed";
    readonly result?: JsonValue;
};
export declare const APPROVAL_GATEWAY_OPERATION_CONTRACTS: Readonly<{
    observe: ProfileOperationContract<"observe", GatewayObservationInput, JsonValue, "output">;
    applyAction: ProfileOperationContract<"applyAction", GatewayActionInput, JsonValue, "output">;
}>;
export declare const APPROVAL_GATEWAY_OPERATIONS: readonly OperationDescriptor[];
export declare const APPROVAL_GATEWAY_SURFACE: SurfaceDescriptor;
export declare const APPROVAL_GATEWAY_CONTRIBUTIONS: Contributions;
export declare const APPROVAL_GATEWAY_ISOLATION: readonly ["provider"];
export declare class ApprovalGatewayFacet<Receipt> {
    private readonly runtime;
    private readonly approval;
    private readonly backend;
    static readonly operations: readonly OperationDescriptor[];
    static readonly surface: SurfaceDescriptor;
    static readonly isolation: readonly ["provider"];
    constructor(runtime: ProtectedProfileRuntimePort<Receipt>, approval: ApprovalGatewayAction, backend: ApprovalGatewayBackend);
    asInternalRuntime(manifest: FacetManifest): InternalProfileFacetRuntime;
    observe(input: GatewayObservationInput): Promise<JsonValue>;
    applyAction(input: GatewayActionInput): Promise<JsonValue>;
}
export type ApprovalGatewayErrorCode = "approval.invalid" | "approval.mismatch";
export declare class ApprovalGatewayError extends DetailedProfileError<ApprovalGatewayErrorCode> {
    constructor(detailCode: ApprovalGatewayErrorCode, message: string);
}
