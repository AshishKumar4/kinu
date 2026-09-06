import type { ProtectedOperationRequest, ProtectedOperationResult } from "../facets/index.js";
import type { InvocationId } from "../interaction-references/index.js";
import type { CanonicalBatchInvoker } from "./canonical-batch.js";
import { type Receipt } from "./receipt.js";
export interface ProfileMediationIdentityPort {
    invocation(request: ProtectedOperationRequest): InvocationId;
}
export declare class InvocationProtectedOperationPort {
    private readonly identities;
    private readonly invocations;
    constructor(identities: ProfileMediationIdentityPort, invocations: CanonicalBatchInvoker<ProtectedOperationRequest>);
    invoke(request: ProtectedOperationRequest): Promise<ProtectedOperationResult<Receipt>>;
}
