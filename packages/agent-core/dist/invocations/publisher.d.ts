import type { InvocationCommitPort, InvocationEventPort, InvocationEvidencePersistence, InvocationTransactionPort } from "./ports.js";
export declare class InvocationPublicationDrainer<Transaction> {
    private readonly transactions;
    private readonly persistence;
    private readonly events;
    private readonly commits;
    private readonly now;
    constructor(transactions: InvocationTransactionPort<Transaction>, persistence: InvocationEvidencePersistence<Transaction>, events: InvocationEventPort, commits: InvocationCommitPort, now: () => Date);
    flush(): Promise<void>;
    private acknowledge;
}
