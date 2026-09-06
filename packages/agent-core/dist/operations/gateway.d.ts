import { Digest, TextId, type ContentRef } from "../core/index.js";
import { AgentCoreError } from "../errors.js";
import { type BindingName, type FacetPackageId, type FacetRef, type OperationDescriptor, type OperationName, type FacetData } from "../facets/index.js";
import type { PrincipalRef } from "../identity/index.js";
import type { FacetRuntimeHost } from "./lifecycle.js";
import { type InterceptionResult, type InterceptorAuthorityPort, type InterceptorTrace } from "./interception.js";
import type { OperationContext } from "./runtime.js";
export declare class OperationRequestKey extends TextId {
    constructor(value: string);
}
export type OperationPayload = {
    readonly kind: "single";
    readonly input: FacetData;
} | {
    readonly kind: "batch";
    readonly inputs: readonly [FacetData, ...FacetData[]];
};
export type OperationPayloadCardinality = {
    readonly kind: "single";
} | {
    readonly kind: "batch";
    readonly itemCount: number;
};
export interface OperationRequest {
    readonly requestKey: OperationRequestKey;
    readonly operation: OperationName;
    readonly payload: OperationPayload;
}
export type OperationDispatchResult = {
    readonly kind: "direct";
    readonly output: FacetData | readonly FacetData[];
} | {
    readonly kind: "mediated";
    readonly output: FacetData | readonly FacetData[];
    readonly evidence: FacetData;
};
export interface AuthorityResolution<Resolution> {
    readonly facet: FacetRef;
    readonly resolution: Resolution;
}
export type MediatedReplayExecutionIdentity = {
    readonly kind: "lease";
    readonly digest: Digest;
} | {
    readonly kind: "route";
    readonly digest: Digest;
};
export interface MediatedReplayBinding {
    readonly principal: PrincipalRef;
    readonly authorityIdentity: Digest;
    readonly packageOperationPin: Digest;
    readonly execution: MediatedReplayExecutionIdentity;
}
export interface OperationAuthorityPort<Caller, Resolution, DirectAuthorization, MediatedAuthorization> extends InterceptorAuthorityPort<Resolution> {
    resolve(caller: Caller, binding: BindingName): Promise<AuthorityResolution<Resolution>>;
    tier(resolution: Resolution, descriptor: OperationDescriptor, hasInterceptors: boolean): "direct" | "mediated";
    authorizeDirect(resolution: Resolution, descriptor: OperationDescriptor, inputs: readonly FacetData[]): DirectAuthorization | undefined;
    authorizeMediated(resolution: Resolution, descriptor: OperationDescriptor, inputs: readonly FacetData[]): Promise<MediatedAuthorization>;
    replayBinding(authorization: MediatedAuthorization, descriptor: OperationDescriptor): MediatedReplayBinding;
    release(resolution: Resolution): void;
}
export interface MediatedInvocationRequest<Authorization> {
    readonly requestKey: OperationRequestKey;
    readonly facet: FacetRef;
    readonly descriptor: OperationDescriptor;
    readonly cardinality: OperationPayloadCardinality;
    readonly inputs: readonly FacetData[];
    readonly authorization: Authorization;
    readonly replayBinding?: MediatedReplayBinding;
    readonly interceptions: readonly (readonly InterceptorTrace[])[];
    execute(itemIndex: number, context: OperationContext): Promise<FacetData>;
}
export interface MediatedInvocationPreflight<Authorization = unknown> {
    readonly requestKey: OperationRequestKey;
    readonly facet: FacetRef;
    readonly descriptor: OperationDescriptor;
    readonly cardinality: OperationPayloadCardinality;
    readonly inputs: readonly FacetData[];
    readonly authorization: Authorization;
    readonly replayBinding: MediatedReplayBinding;
}
export interface MediatedInvocationPreparation {
    readonly inputs: readonly FacetData[];
    readonly interceptions: readonly (readonly InterceptorTrace[])[];
}
export type MediatedPreflightResult = {
    readonly kind: "new";
    readonly preparation: MediatedInvocationPreparation;
} | {
    readonly kind: "replay";
    readonly result: OperationDispatchResult;
};
export interface OperationInterceptionEvidence {
    readonly requestKey: OperationRequestKey;
    readonly facet: FacetRef;
    readonly descriptor: OperationDescriptor;
    readonly cardinality: OperationPayloadCardinality;
    readonly traces: readonly (readonly InterceptorTrace[])[];
}
export interface MediatedInvocationResult {
    readonly outputs: readonly FacetData[];
    readonly evidence: FacetData;
}
export interface OperationInvocationPort<DirectAuthorization, MediatedAuthorization> {
    directContext(requestKey: OperationRequestKey, itemIndex: number, cardinality: OperationPayloadCardinality, authorization: DirectAuthorization): OperationContext;
    prepareMediated(request: MediatedInvocationPreflight<MediatedAuthorization>, prepare: () => MediatedInvocationPreparation): Promise<MediatedPreflightResult>;
    invoke(request: MediatedInvocationRequest<MediatedAuthorization>): Promise<MediatedInvocationResult>;
    recordDirectInterceptions(evidence: OperationInterceptionEvidence): void;
    presentMediated(evidence: FacetData, outputs: readonly FacetData[], present: (itemIndex: number, output: FacetData) => InterceptionResult, interceptions: Omit<OperationInterceptionEvidence, "traces">): Promise<readonly FacetData[]>;
}
/**
 * The Invocation plane's detached admission (SPEC §5.6, C13-TURN-HANDLE-DETACHMENT).
 *
 * A detached admission commits the item's effect evidence and stops there: the effect runs
 * later, under the plane that owns the item, and never under the dispatching Turn's live
 * resources. So this seam takes the request the one dispatch assembly composed and returns
 * whatever the Invocation plane says the item became. `Admission` stays opaque here because
 * the answer is that plane's own record shape, and the operations context composes the steps
 * before an effect rather than interpreting the evidence after one.
 */
export interface DetachedInvocationAdmissionPort<MediatedAuthorization, Admission> {
    admitDetached(request: MediatedInvocationRequest<MediatedAuthorization>, itemIndex: number): Promise<Admission>;
}
export declare abstract class OperationGateway {
    abstract resolve(binding: BindingName): Promise<ResolvedFacet>;
}
export declare abstract class ResolvedFacet implements Disposable {
    abstract readonly facet: FacetRef;
    abstract readonly package: FacetPackageId;
    abstract descriptor(name: OperationName): OperationDescriptor | undefined;
    abstract dispatch(request: OperationRequest): Promise<OperationDispatchResult>;
    abstract [Symbol.dispose](): void;
}
export declare class OperationGatewayHost<Caller, Resolution, DirectAuthorization, MediatedAuthorization> extends OperationGateway {
    #private;
    private readonly caller;
    private readonly host;
    private readonly authority;
    private readonly invocations;
    constructor(caller: Caller, host: FacetRuntimeHost, authority: OperationAuthorityPort<Caller, Resolution, DirectAuthorization, MediatedAuthorization>, invocations: OperationInvocationPort<DirectAuthorization, MediatedAuthorization>);
    resolve(binding: BindingName): Promise<ResolvedFacet>;
    /**
     * Admits one item of a mediated dispatch and detaches its execution (SPEC §5.6).
     *
     * It reaches the item through exactly the assembly `dispatch` reaches an effect through —
     * one authority resolution, one tier decision, one interceptor pass, one preflight — and
     * differs only in the last step: the Invocation plane records the item's admission and
     * runs nothing. The admission is returned rather than handed to a callback, because the
     * caller publishes it and a handle nobody received is an admitted item no Run ever holds.
     *
     * The resolution is released here rather than by the caller: a detached admission is one
     * shot with no dispatch to follow, so nothing outlives this call to dispose.
     */
    admitDetached<Admission>(binding: BindingName, request: OperationRequest, itemIndex: number, admissions: DetachedInvocationAdmissionPort<MediatedAuthorization, Admission>): Promise<Admission>;
    /**
     * The one resolution both entries are built from. `resolve` widens it to the contract a
     * caller holds, while the detached admission needs the concrete facet: its entry is not on
     * `ResolvedFacet`, because that contract cannot name this host's authorization type and a
     * seam that erased it would admit a port belonging to another authority plane.
     */
    private resolveProtected;
}
export declare class ConfirmedOperationFailure extends AgentCoreError {
    readonly evidence: ContentRef;
    constructor(message: string, evidence: ContentRef);
}
