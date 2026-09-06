import type { InvocationId } from "../interaction-references/index.js";
import type { SlateDeployInvocationIntent, SlateResourceInvocationIntent } from "./intent.js";
import type { SlateEffectContext } from "./seams.js";
interface SlateProviderEffectRequest {
    readonly invocationId: InvocationId;
    readonly effectContext: SlateEffectContext;
    readonly idempotencyKey: string;
}
export interface SlateProviderDeploymentRequest extends SlateDeployInvocationIntent, SlateProviderEffectRequest {
}
export interface SlateProviderDeployment {
    readonly materialization: import("../core/index.js").ContentRef;
}
export interface SlateProviderResourceRequest extends SlateResourceInvocationIntent, SlateProviderEffectRequest {
}
export interface SlateProviderResource {
    readonly materialization: import("../core/index.js").ContentRef;
}
export declare abstract class SlateProvider {
    abstract deploy(request: SlateProviderDeploymentRequest): Promise<SlateProviderDeployment>;
    abstract reconcileDeployment(request: SlateProviderDeploymentRequest): Promise<SlateProviderDeployment>;
    abstract materializeResource(request: SlateProviderResourceRequest): Promise<SlateProviderResource>;
    abstract reconcileResource(request: SlateProviderResourceRequest): Promise<SlateProviderResource>;
}
export {};
