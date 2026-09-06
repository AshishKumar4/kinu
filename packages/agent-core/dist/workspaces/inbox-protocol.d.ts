import type { LeaseToken } from "../agents/index.js";
import type { RunInboxOutcome, RunInboxPort } from "./ports.js";
import { InboxEventReference } from "./inbox.js";
export declare class InboxProtocol<Transaction> {
    private readonly runs;
    constructor(runs: RunInboxPort<Transaction>);
    append(transaction: Transaction, reference: InboxEventReference, lease: LeaseToken): RunInboxOutcome;
}
