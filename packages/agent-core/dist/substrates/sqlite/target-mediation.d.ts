import type { ActorRef } from "../../actors/index.js";
import { type AuthorityPermitExpectation, type AuthorityPermitTargetAdmissionStore, type AuthorityPermitTargetDenialStore, type AuthorityPermitTargetRequestStore, type ScopeEpoch } from "../../authority/index.js";
import { TargetPermitMediationAggregate, type AuthorityPermitReference, type MediationPersistence } from "../../composition/index.js";
import type { PrincipalRef, TenantId } from "../../identity/index.js";
import { type InvocationEvidencePersistence, type InvocationReplayPersistence } from "../../invocations/index.js";
import type { TransactionalSqlite } from "./sqlite.js";
export declare abstract class SqliteTargetResolutionInvalidationPort {
    abstract invalidate(transaction: TransactionalSqlite, expectation: AuthorityPermitExpectation): void;
}
/** One physical SQLite Actor store behind the complete target mediation surface. */
export declare class SqliteTargetPermitMediationAggregate extends TargetPermitMediationAggregate<TransactionalSqlite> {
    #private;
    readonly tenant: TenantId;
    readonly actor: ActorRef;
    private readonly invalidations;
    readonly persistence: MediationPersistence<TransactionalSqlite, AuthorityPermitReference>;
    readonly evidence: InvocationEvidencePersistence<TransactionalSqlite> & InvocationReplayPersistence<TransactionalSqlite>;
    readonly permitRequests: AuthorityPermitTargetRequestStore<TransactionalSqlite>;
    readonly permitDenials: AuthorityPermitTargetDenialStore<TransactionalSqlite>;
    readonly permitAdmission: AuthorityPermitTargetAdmissionStore<TransactionalSqlite>;
    constructor(database: TransactionalSqlite, tenant: TenantId, actor: ActorRef, invalidations: SqliteTargetResolutionInvalidationPort);
    transact<Result>(operation: (transaction: TransactionalSqlite) => Result): Result;
    joinDeniedEpochs(transaction: TransactionalSqlite, principal: PrincipalRef, entries: readonly ScopeEpoch[]): void;
    invalidateResolution(transaction: TransactionalSqlite, expectation: AuthorityPermitExpectation): void;
    private requireActive;
}
