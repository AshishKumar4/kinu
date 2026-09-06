import { type FacetData, type OperationContext } from "../facets/index.js";
import type { MediatedInvocationPreflight, MediatedInvocationPreparation, MediatedInvocationRequest, MediatedInvocationResult, MediatedPreflightResult, InterceptorTrace, OperationInterceptionEvidence, OperationInvocationPort, OperationPayloadCardinality, OperationRequestKey } from "../operations/index.js";
import { InvocationId } from "../interaction-references/index.js";
import type { CanonicalBatchInvoker } from "./canonical-batch.js";
import type { InvocationReplayPersistence, InvocationTransactionPort } from "./ports.js";
export interface DirectOperationContextPort<Authorization> {
    context(requestKey: OperationRequestKey, itemIndex: number, cardinality: OperationPayloadCardinality, authorization: Authorization): OperationContext;
}
export interface MediatedInvocationIdentityPort {
    invocation(request: MediatedInvocationPreflight<unknown>): InvocationId;
}
export declare class ReplayOperationInvocationPort<Transaction, DirectAuthorization, MediatedAuthorization> implements OperationInvocationPort<DirectAuthorization, MediatedAuthorization> {
    private readonly scope;
    private readonly transactions;
    private readonly persistence;
    private readonly identities;
    private readonly direct;
    private readonly mediated;
    constructor(scope: string, transactions: InvocationTransactionPort<Transaction>, persistence: InvocationReplayPersistence<Transaction>, identities: MediatedInvocationIdentityPort, direct: DirectOperationContextPort<DirectAuthorization>, mediated: CanonicalBatchInvoker<MediatedAuthorization>);
    directContext(requestKey: OperationRequestKey, itemIndex: number, cardinality: OperationPayloadCardinality, authorization: DirectAuthorization): OperationContext;
    prepareMediated(request: MediatedInvocationPreflight<MediatedAuthorization>, prepare: () => MediatedInvocationPreparation): Promise<MediatedPreflightResult>;
    invoke(request: MediatedInvocationRequest<MediatedAuthorization>): Promise<MediatedInvocationResult>;
    /**
     * The direct tier carries no interceptions to attribute: an applicable
     * `operation.before` or `operation.after` interceptor forces the mediated tier (§7.2),
     * and the gateway asks the same candidate set that runs them. Asserting that here keeps
     * the invariant from decaying into silently discarded attribution evidence.
     */
    recordDirectInterceptions(evidence: OperationInterceptionEvidence): void;
    presentMediated(evidence: FacetData, outputs: readonly FacetData[], present: (itemIndex: number, output: FacetData) => {
        readonly value: FacetData;
        readonly traces: readonly InterceptorTrace[];
    }, interceptions: Omit<OperationInterceptionEvidence, "traces">): Promise<readonly FacetData[]>;
}
