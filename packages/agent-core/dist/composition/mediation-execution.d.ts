import type { ContentStore } from "../content/index.js";
import type { OperationContext } from "../facets/index.js";
import type { OperationPayloadCardinality, OperationRequestKey } from "../operations/index.js";
import type { DirectOperationContextPort } from "../invocations/index.js";
import type { DerivedMediationIdentities } from "./mediation-identity.js";
export interface OperationExecutionResources {
    readonly signal: AbortSignal;
    readonly content: ContentStore;
}
/**
 * The direct tier's OperationContext (§7.2). A direct Invocation creates no durable
 * Invocation, Receipt, or replay record, so it carries no EffectAttempt and no target
 * admission — asserting that here is what keeps a direct dispatch from presenting itself
 * as mediated evidence. Its Invocation and item identities are derived from the request
 * key so a repeated direct dispatch names the same call.
 */
export declare class DerivedDirectOperationContext<Authorization> implements DirectOperationContextPort<Authorization> {
    private readonly identities;
    private readonly resources;
    constructor(identities: DerivedMediationIdentities, resources: (authorization: Authorization, itemIndex: number) => OperationExecutionResources);
    context(requestKey: OperationRequestKey, itemIndex: number, cardinality: OperationPayloadCardinality, authorization: Authorization): OperationContext;
}
