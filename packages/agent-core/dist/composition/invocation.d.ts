import { InvocationPublicationDrainer, ReplayOperationInvocationPort, type CanonicalBatchInvoker, type DirectOperationContextPort, type InvocationCommitPort, type InvocationEventPort, type InvocationEvidencePersistence, type InvocationReplayPersistence, type InvocationTransactionPort, type MediatedInvocationIdentityPort } from "../invocations/index.js";
export interface InvocationCompositionInit<Transaction, DirectAuthorization, MediatedAuthorization> {
    readonly scope: string;
    readonly transactions: InvocationTransactionPort<Transaction>;
    readonly persistence: InvocationReplayPersistence<Transaction> & InvocationEvidencePersistence<Transaction>;
    readonly identities: MediatedInvocationIdentityPort;
    readonly direct: DirectOperationContextPort<DirectAuthorization>;
    readonly mediated: CanonicalBatchInvoker<MediatedAuthorization>;
    readonly events: InvocationEventPort;
    readonly commits: InvocationCommitPort;
    readonly now: () => Date;
}
export declare class InvocationComposition<Transaction, DirectAuthorization, MediatedAuthorization> {
    readonly operations: ReplayOperationInvocationPort<Transaction, DirectAuthorization, MediatedAuthorization>;
    readonly outbox: InvocationPublicationDrainer<Transaction>;
    constructor(init: InvocationCompositionInit<Transaction, DirectAuthorization, MediatedAuthorization>);
}
