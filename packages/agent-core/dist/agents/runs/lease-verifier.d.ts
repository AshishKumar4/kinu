import type { LeaseToken, TurnLeaseVerifier } from "./lease.js";
import { TurnLease } from "./lease.js";
import type { RunRepository } from "./store.js";
export declare class MemoryTurnLeaseVerifier implements TurnLeaseVerifier {
    #private;
    private readonly now;
    constructor(leases?: readonly TurnLease[], now?: () => Date);
    save(lease: TurnLease): void;
    permits(token: LeaseToken): boolean;
}
export declare class RepositoryTurnLeaseVerifier<Transaction> implements TurnLeaseVerifier {
    private readonly repository;
    private readonly now;
    constructor(repository: RunRepository<Transaction>, now?: () => Date);
    permits(token: LeaseToken): boolean;
}
