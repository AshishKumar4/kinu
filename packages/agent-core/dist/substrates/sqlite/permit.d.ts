import type { ActorActivation, ActorLocalStore, ActorRecoveryState, ActorRef, SynchronousResultGuard, TransactionOperation } from "../../actors/index.js";
import { AuthorityPermit, TenantAuthorityTransactionPort, type AuthenticatedAuthorityPermit, type AuthorityPermitExpectation, type AuthorityPermitIssueStore, type AuthorityPermitTargetStore, type TenantAuthorityReadStore, TargetAuthorityPermitDenial, TargetAuthorityPermitRequest, TargetLeaseEvidence, TargetLeaseEvidenceReference } from "../../authority/index.js";
import { Digest } from "../../core/index.js";
import { ReadableSqlite, TransactionalSqlite } from "./sqlite.js";
/** One prune page: what it removed, how far it read, and where the next page resumes. */
export interface AuthorityPermitPrunePage {
    readonly removed: number;
    readonly examined: number;
    readonly more: boolean;
    readonly cursor: string;
}
export declare class SqliteAuthorityPermitStore implements AuthorityPermitTargetStore<TransactionalSqlite>, AuthorityPermitIssueStore<TransactionalSqlite> {
    #private;
    private readonly database;
    readonly owner: ActorRef;
    constructor(database: TransactionalSqlite, owner: ActorRef);
    transaction<Result>(operation: (transaction: TransactionalSqlite) => Result, ...guard: SynchronousResultGuard<Result>): Result;
    issued(transaction: TransactionalSqlite, nonce: string): AuthorityPermit | undefined;
    projectedEvidence(transaction: TransactionalSqlite, reference: TargetLeaseEvidenceReference): TargetLeaseEvidence | undefined;
    projectEvidence(transaction: TransactionalSqlite, evidence: TargetLeaseEvidence): TargetLeaseEvidence;
    requested(transaction: TransactionalSqlite, nonce: string): TargetAuthorityPermitRequest | undefined;
    consumed(transaction: TransactionalSqlite, nonce: string): Digest | undefined;
    denied(transaction: TransactionalSqlite, nonce: string): TargetAuthorityPermitDenial | undefined;
    request(transaction: TransactionalSqlite, request: TargetAuthorityPermitRequest): TargetAuthorityPermitRequest;
    deny(transaction: TransactionalSqlite, denial: TargetAuthorityPermitDenial): TargetAuthorityPermitDenial;
    issue(transaction: TransactionalSqlite, permit: AuthorityPermit): AuthorityPermit;
    consume(transaction: TransactionalSqlite, authentication: AuthenticatedAuthorityPermit, permit: AuthorityPermit, expected: AuthorityPermitExpectation, now: Date): void;
    private row;
    private consumptionRow;
    private denialRow;
    /**
     * Deletes rows whose permit expiry precedes `before`, reading at most `limit` candidates
     * after the `after` cursor, and reports where the next page resumes.
     *
     * Time settles a permit, not the consumption ledger. An expired permit can decide nothing
     * on either side: issuance refuses a request whose expiry is not after the issuance clock,
     * and assertConsumable refuses a permit outside its window, so a row whose expiry has
     * passed buys nothing whether or not it was ever consumed or denied. Keying retention on
     * settled rows left every unsettled row — an abandoned request, an issuance the target
     * never came back for — resident forever, which is the unbounded growth this exists to
     * stop. The caller subtracts its retention from the horizon, so `before` already means
     * expiry plus retention.
     *
     * The page is a keyset, not an offset. A fixed `ORDER BY nonce LIMIT n` window is occupied
     * by whatever sorts first, so a run of rows too young to prune at the head of the ordering
     * would fill every page forever and no later row would ever be reached. The cursor moves
     * past everything examined, pruned or not, so the sweep always advances.
     *
     * Excluded on purpose: authority_permit_lease_evidence. Its rows are keyed by source and
     * idempotency key rather than by nonce, so this nonce-ordered walk cannot reach them
     * coherently, and a source may legitimately re-project an attestation after the permit it
     * attested expired. Sweeping it needs its own source-keyed pass; the exclusion is recorded
     * on the conformance row rather than left for a reader to infer.
     */
    prune(transaction: TransactionalSqlite, before: Date, limit: number, after?: string): AuthorityPermitPrunePage;
    private decodeRequested;
    private decodeIssued;
    private decodeConsumed;
    private decodeDenied;
    /**
     * The state a nonce row declares, refused when it is not one this store writes or when
     * the stored record does not match it.
     *
     * A reader must not filter on state and return nothing: an unknown state, or a record of
     * the wrong kind for its state, is corruption and silently reading past it hands a caller
     * "no such nonce" for a row that exists. Recovery caught this by decoding every row on
     * construction; the read that meets the row catches it now, which is the same refusal
     * without the unbounded startup scan.
     */
    private requireNonceState;
    /**
     * The expiry a stored nonce row carries, for a store on either side of the permit.
     *
     * `decodeIssued` cannot serve this: it asserts the permit's issuer IS this store's owner,
     * which holds on the Tenant side and never on the target side, so a target's prune would
     * find nothing prunable at all.
     */
    private storedExpiry;
    /**
     * The refusal a nonce that would not take a write deserves, named for who actually holds
     * it. `INSERT OR IGNORE` no-ops silently against a row another Actor owns, and the
     * read-back then sees nothing; reporting that as this Actor having used the nonce blames
     * the wrong party and hides a shared-database collision behind a replay message.
     */
    private occupancyDenial;
    /** Whether this row's owner columns name an Actor other than this store's owner. */
    private ownedByAnother;
    private validateOwner;
    private requireTransaction;
}
/** Binds a Tenant's current authority view and issued permits to one SQLite transaction. */
export declare class SqliteTenantAuthorityPermitStore extends TenantAuthorityTransactionPort<TransactionalSqlite> implements ActorLocalStore<TransactionalSqlite, ReadableSqlite>, AuthorityPermitIssueStore<TransactionalSqlite> {
    #private;
    private readonly database;
    readonly owner: ActorRef;
    constructor(database: TransactionalSqlite, owner: ActorRef);
    bindActor(actor: ActorRef): void;
    activateActor(actor: ActorRef, start: (transaction: TransactionalSqlite, activation: ActorActivation) => void): ActorRecoveryState;
    loadRecoveryState(transaction: TransactionalSqlite, actor: ActorRef): ActorRecoveryState | undefined;
    saveRecoveryState(transaction: TransactionalSqlite, state: ActorRecoveryState): void;
    loadRecordSetDeclaration(transaction: TransactionalSqlite, actor: ActorRef): Uint8Array | undefined;
    saveRecordSetDeclaration(transaction: TransactionalSqlite, actor: ActorRef, declaration: Uint8Array): void;
    authority(transaction: TransactionalSqlite): TenantAuthorityReadStore;
    transaction<Result>(operation: TransactionOperation<TransactionalSqlite, Result>, ...guard: SynchronousResultGuard<Result>): Result;
    read<Result>(transaction: TransactionalSqlite, operation: TransactionOperation<ReadableSqlite, Result>, ...guard: SynchronousResultGuard<Result>): Result;
    projectedEvidence(transaction: TransactionalSqlite, reference: TargetLeaseEvidenceReference): TargetLeaseEvidence | undefined;
    projectEvidence(transaction: TransactionalSqlite, evidence: TargetLeaseEvidence): TargetLeaseEvidence;
    issued(transaction: TransactionalSqlite, nonce: string): AuthorityPermit | undefined;
    issue(transaction: TransactionalSqlite, permit: AuthorityPermit): AuthorityPermit;
    private requireTransaction;
}
