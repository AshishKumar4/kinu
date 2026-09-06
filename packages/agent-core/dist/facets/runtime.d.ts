import type { ContentStore } from "../content/index.js";
import type { Digest } from "../core/index.js";
import type { TurnId } from "../execution-references/index.js";
import type { InvocationId } from "../interaction-references/index.js";
import type { EffectAttemptId } from "../invocation-references/index.js";
import type { InterceptorDeclaration, OperationCutPoint, TurnBoundCutPoint } from "./interceptor.js";
import type { FacetData } from "./data.js";
import type { OperationDescriptor, SurfaceDescriptor } from "./contribution.js";
import type { FacetRef, OperationName, SurfaceId } from "./id.js";
import type { FacetManifest } from "./manifest.js";
export interface FacetLifecycleContext {
    readonly signal: AbortSignal;
}
export interface OperationContext {
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly idempotencyKey: string;
    readonly attempt?: OperationAttemptIdentity;
    readonly targetAdmission?: unknown;
    readonly signal: AbortSignal;
    readonly content: ContentStore;
}
export interface OperationAttemptIdentity {
    readonly id: EffectAttemptId;
    readonly ordinal: number;
    readonly intentDigest: Digest;
}
export declare abstract class Operation<I extends FacetData = FacetData, O extends FacetData = FacetData> {
    abstract readonly descriptor: OperationDescriptor;
    abstract execute(context: OperationContext, input: I): Promise<O>;
}
export type ProtectedOperationResult<Receipt> = {
    readonly kind: "output";
    readonly output: FacetData;
    readonly receipt?: Receipt;
} | {
    readonly kind: "receipt";
    readonly receipt: Receipt;
};
export interface ProtectedOperationRequest {
    readonly facet: FacetRef;
    readonly binding: import("./id.js").BindingName;
    readonly operation: Operation;
    readonly input: FacetData;
    readonly resultMode: "output" | "receipt";
}
export declare abstract class ProtectedOperationPort<Receipt> {
    abstract invoke(request: ProtectedOperationRequest): Promise<ProtectedOperationResult<Receipt>>;
}
/**
 * The two operation cut points, where the value in flight belongs to one Operation of one
 * target Facet and `appliesTo` is the selector that scoped it there (SPEC §4.4).
 */
export interface OperationInterceptContext {
    readonly cutPoint: OperationCutPoint;
    readonly operation: OperationDescriptor;
    readonly target: FacetRef;
    readonly interceptor: InterceptorDeclaration;
}
/**
 * The three Turn-bound cut points. There is no target Operation here, so nothing an
 * `OperationSelector` could name is in flight and the Turn is what the context carries
 * instead: a step, a submission, and a prompt each belong to exactly one Turn, and the
 * refusals at these cut points are all scoped to that Turn (SPEC §4.4, §5.3).
 */
export interface TurnInterceptContext {
    readonly cutPoint: TurnBoundCutPoint;
    readonly turn: TurnId;
    readonly interceptor: InterceptorDeclaration;
}
export type InterceptContext = OperationInterceptContext | TurnInterceptContext;
export type InterceptResult = {
    readonly proceed: true;
    readonly value: FacetData;
} | {
    readonly proceed: false;
    readonly reason: string;
};
export declare abstract class Interceptor {
    abstract readonly declaration: InterceptorDeclaration;
    abstract intercept(context: InterceptContext, value: FacetData): InterceptResult;
}
export declare abstract class Surface {
    abstract readonly descriptor: SurfaceDescriptor;
    abstract render(context: OperationContext, input: FacetData): Promise<FacetData>;
}
export declare abstract class Facet {
    abstract readonly ref: FacetRef;
    abstract readonly manifest: FacetManifest;
    abstract operation(name: OperationName): Operation | undefined;
    abstract surface(id: SurfaceId): Surface | undefined;
    abstract interceptor(id: InterceptorDeclaration["id"]): Interceptor | undefined;
    abstract children(): readonly Facet[];
    abstract start(context: FacetLifecycleContext): Promise<void>;
    abstract stop(context: FacetLifecycleContext): Promise<void>;
}
