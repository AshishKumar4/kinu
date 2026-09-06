import { ContentStore } from "../content/index.js";
import { type Digest } from "../core/index.js";
import { ApprovalGatewayBackend, ProtectedProfileRuntimePort, type ProfileRuntimeEffectsPort, type ProfileRuntimeHostBinding } from "../facets/index.js";
import { type EffectAttempt, type EffectReconciliationPort, InvocationProtectedOperationPort, type Receipt, type ReconciliationResult } from "../invocations/index.js";
export declare function createProtectedProfileRuntime(host: ProfileRuntimeHostBinding, operations: InvocationProtectedOperationPort, effects: ProfileRuntimeEffectsPort<Receipt>): ProtectedProfileRuntimePort<Receipt>;
export declare class ApprovalGatewayReconciliationPort<Lease, Admission> implements EffectReconciliationPort<Lease, Admission> {
    private readonly backend;
    private readonly content;
    constructor(backend: ApprovalGatewayBackend, content: ContentStore);
    query(attempt: EffectAttempt<Lease, Admission>, intentDigest: Digest): Promise<ReconciliationResult>;
}
