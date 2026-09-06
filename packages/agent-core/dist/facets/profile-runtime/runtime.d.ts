import { Digest, type JsonSchema, type ObjectRecord } from "../../core/index.js";
import type { InvocationId } from "../../interaction-references/index.js";
import { EffectAttemptId } from "../../invocation-references/index.js";
import { Operation, Surface, type OperationContext, type ProtectedOperationPort } from "../runtime.js";
import type { OperationDescriptor, SurfaceDescriptor } from "../contribution.js";
import type { FacetData } from "../data.js";
import type { EventDeclaration } from "../event.js";
import { BindingName, FacetRef } from "../id.js";
import type { ProfileControlContract, ProfileEventContract, ProfileOperationContract, ProfileOperationResultMode, PublicProfileInput } from "./contract.js";
export declare class ProfileRuntimeHostBinding {
    readonly facet: FacetRef;
    readonly binding: BindingName;
    constructor(facet: FacetRef, binding: BindingName);
}
export declare class EffectDispatchAttempt {
    readonly id: EffectAttemptId;
    readonly ordinal: number;
    readonly intentDigest: Digest;
    constructor(id: EffectAttemptId, ordinal: number, intentDigest: Digest);
}
/**
 * The canonical identity an external effect must carry to its provider transport.
 * Derived once from {@link ProfileEffectContext.dispatch}; a facet never re-reads the
 * individual identity fields. A provider MUST treat `idempotencyKey` as the dedup key
 * for the effect and MUST be able to answer a reconciliation query addressed by
 * `attempt` identity, so that a crash-after-send retry neither duplicates the effect
 * nor leaves it permanently indeterminate (SPEC §7.4).
 */
export declare class EffectDispatch {
    readonly idempotencyKey: string;
    readonly attempt: EffectDispatchAttempt | undefined;
    constructor(idempotencyKey: string, attempt?: EffectDispatchAttempt | undefined);
}
/**
 * The invocation a profile handler is running under, as the handler sees it: the identity an
 * external effect carries to its transport, and the cancellation of the Turn or Run that
 * owns the invocation (SPEC §4.1, C13-FACET-CANCELLATION-REACH).
 *
 * The cancellation is here because a handler that awaits further asynchronous work under
 * its own invocation's lifetime has to pass it on, and a derivation that dropped it left
 * every profile handler unable to — availability at the `Operation.execute` boundary and
 * availability inside the handler that boundary calls are the same requirement, so this
 * context conveys exactly the signal its `OperationContext` conveyed and never a substitute.
 */
export declare class ProfileEffectContext {
    readonly cancellation: AbortSignal;
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly idempotencyKey: string;
    readonly attempt: EffectAttemptId | undefined;
    readonly attemptOrdinal: number | undefined;
    readonly intentDigest: Digest | undefined;
    readonly targetAdmission: ObjectRecord | undefined;
    constructor(cancellation: AbortSignal, invocation: InvocationId, itemIndex: number, idempotencyKey: string, attempt: EffectAttemptId | undefined, attemptOrdinal: number | undefined, intentDigest: Digest | undefined, targetAdmission?: ObjectRecord | undefined);
    static fromOperation(context: OperationContext): ProfileEffectContext;
    /**
     * A bound of the handler's own that stays linked to the cancellation it derived from
     * (SPEC §4.1): the returned signal aborts when this bound elapses *or* when the
     * invocation's cancellation fires. A handler that built an independent timer would
     * satisfy its own seam while dropping cancellation at the next one, so deriving a
     * narrower deadline goes through here and carries the upstream link with it.
     */
    bound(milliseconds: number): AbortSignal;
    dispatch(): EffectDispatch;
}
export interface ProfileOperationAdmission {
    readonly descriptor: OperationDescriptor;
    readonly resultMode: ProfileOperationResultMode;
}
export interface ProfileControlAdmission {
    readonly name: string;
    readonly input: JsonSchema;
    readonly output: JsonSchema;
}
export declare abstract class ProfileRuntimeEffectsPort<Receipt = unknown> {
    abstract emit(host: ProfileRuntimeHostBinding, declaration: EventDeclaration, payload: FacetData, cause: Receipt): Promise<void>;
    abstract control(host: ProfileRuntimeHostBinding, control: ProfileControlAdmission, input: FacetData, execute: (input: FacetData) => Promise<FacetData>): Promise<FacetData>;
    abstract render(host: ProfileRuntimeHostBinding, descriptor: SurfaceDescriptor, context: OperationContext, input: FacetData): Promise<FacetData>;
}
export declare class ProtectedProfileRuntimePort<Receipt> {
    #private;
    readonly host: ProfileRuntimeHostBinding;
    private readonly operations;
    private readonly effects;
    constructor(host: ProfileRuntimeHostBinding, operations: ProtectedOperationPort<Receipt>, effects: ProfileRuntimeEffectsPort<Receipt>);
    get active(): boolean;
    activate(): void;
    deactivate(): void;
    operation<Name extends string, Input, Output, Mode extends ProfileOperationResultMode>(contract: ProfileOperationContract<Name, Input, Output, Mode>, handler: (input: Input, context: ProfileEffectContext) => Output | Promise<Output>): Operation;
    surface(descriptor: SurfaceDescriptor): Surface;
    invoke<Name extends string, Input, Output, Mode extends ProfileOperationResultMode>(contract: ProfileOperationContract<Name, Input, Output, Mode>, input: Input, handler: (input: Input, context: ProfileEffectContext) => Output | Promise<Output>): Promise<Mode extends "receipt" ? Receipt : Output>;
    invokeWithReceipt<Name extends string, Input, Output>(contract: ProfileOperationContract<Name, Input, Output, "output">, input: Input, handler: (input: Input, context: ProfileEffectContext) => Output | Promise<Output>): Promise<{
        readonly output: Output;
        readonly receipt: Receipt;
    }>;
    emit<Kind extends string, Payload extends PublicProfileInput>(contract: ProfileEventContract<Kind, Payload>, payload: Payload, cause: Receipt): Promise<void>;
    control<Name extends string, Input extends PublicProfileInput, Output>(contract: ProfileControlContract<Name, Input, Output>, input: Input, handler: (input: Input) => Output | Promise<Output>): Promise<Output>;
    private requireActive;
    private invokeRaw;
}
