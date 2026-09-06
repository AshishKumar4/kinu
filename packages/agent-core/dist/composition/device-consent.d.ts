import { type DeviceAgentBinding, type DeviceConsentBackend, type FacetRef, type ProtectedOperationRequest } from "../facets/index.js";
import type { CanonicalBatchFinalAdmissionContext, CanonicalBatchFinalAdmissionPort, CanonicalBatchFinalAdmissionResult, CanonicalBatchInvocationRequest } from "../invocations/index.js";
export declare class DeviceConsentFinalAdmissionPort<Transaction, Lease, Authority, Domain, PathEpochs, Admission> implements CanonicalBatchFinalAdmissionPort<Transaction, ProtectedOperationRequest, Lease, Authority, Domain, PathEpochs, Admission> {
    private readonly target;
    private readonly agent;
    private readonly consent;
    constructor(target: FacetRef, agent: DeviceAgentBinding, consent: DeviceConsentBackend<Transaction>);
    admit(transaction: Transaction, request: CanonicalBatchInvocationRequest<ProtectedOperationRequest>, _context: CanonicalBatchFinalAdmissionContext<Lease, Authority, Domain, PathEpochs, Admission>): CanonicalBatchFinalAdmissionResult;
}
