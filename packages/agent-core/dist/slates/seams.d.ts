import { InvocationId } from "../interaction-references/index.js";
import type { ReceiptId } from "../invocation-references/index.js";
import type { SlateInvocationRequest, SlateMutationRequest, SlatePreviewLinkIntent } from "./intent.js";
export declare abstract class SlateMutationSeam {
    abstract mutate<Result>(request: SlateMutationRequest, mutation: () => Result): Promise<Result>;
}
export type SlateInvocationResult<Result> = {
    readonly outcome: "succeeded";
    readonly receiptId: ReceiptId;
    readonly value: Result;
} | {
    readonly outcome: "failed" | "indeterminate";
    readonly receiptId: ReceiptId;
};
export declare class SlateEffectContext {
    readonly invocationId: InvocationId;
    readonly itemIndex: number;
    readonly attemptOrdinal: number;
    readonly idempotencyKey: string;
    constructor(invocationId: InvocationId, itemIndex: number, attemptOrdinal: number, idempotencyKey: string);
    sameItem(other: SlateEffectContext): boolean;
}
export declare abstract class SlateInvocationSeam {
    abstract prepare(request: SlateInvocationRequest): Promise<InvocationId>;
    abstract invoke<Result>(request: SlateInvocationRequest, invocationId: InvocationId, effect: (context: SlateEffectContext) => Promise<Result>): Promise<SlateInvocationResult<Result>>;
    abstract reconcile<Result>(request: SlateInvocationRequest, invocationId: InvocationId, effect: (context: SlateEffectContext) => Promise<Result>): Promise<SlateInvocationResult<Result>>;
}
export declare abstract class SlatePreviewValidationSeam {
    abstract validate(request: SlatePreviewLinkIntent): Promise<void>;
}
