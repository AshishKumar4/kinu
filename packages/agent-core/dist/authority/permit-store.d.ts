import { type ActorRef, type SynchronousResultGuard } from "../actors/index.js";
import { Digest } from "../core/index.js";
import type { AuthorityCheckEvidence } from "./evidence.js";
import { AuthorityPermit, AuthorityPermitExpectation } from "./permit.js";
import { TargetAuthorityPermitDenial } from "./permit-denial.js";
import { TargetAuthorityPermitRequest } from "./permit-request.js";
import { TargetLeaseEvidence, TargetLeaseEvidenceReference } from "./target-lease-evidence.js";
import { type AuthenticatedAuthorityPermit } from "./permit-authentication.js";
export interface AuthorityPermitTransactionStore<Transaction> {
    readonly owner: ActorRef;
    transaction<Result>(operation: (transaction: Transaction) => Result, ...guard: SynchronousResultGuard<Result>): Result;
}
export interface AuthorityPermitTargetRequestStore<Transaction> extends AuthorityPermitTransactionStore<Transaction> {
    requested(transaction: Transaction, nonce: string): TargetAuthorityPermitRequest | undefined;
    request(transaction: Transaction, request: TargetAuthorityPermitRequest): TargetAuthorityPermitRequest;
}
export interface AuthorityPermitTargetDenialStore<Transaction> {
    readonly owner: ActorRef;
    requested(transaction: Transaction, nonce: string): TargetAuthorityPermitRequest | undefined;
    denied(transaction: Transaction, nonce: string): TargetAuthorityPermitDenial | undefined;
    deny(transaction: Transaction, denial: TargetAuthorityPermitDenial): TargetAuthorityPermitDenial;
}
export interface AuthorityPermitTargetAdmissionStore<Transaction> {
    readonly owner: ActorRef;
    consumed(transaction: Transaction, nonce: string): Digest | undefined;
    consume(transaction: Transaction, authentication: AuthenticatedAuthorityPermit, permit: AuthorityPermit, expected: AuthorityPermitExpectation, now: Date): void;
}
export interface AuthorityPermitTargetStore<Transaction> extends AuthorityPermitTargetRequestStore<Transaction>, AuthorityPermitTargetDenialStore<Transaction>, AuthorityPermitTargetAdmissionStore<Transaction> {
}
export interface AuthorityPermitEvidenceProjectionStore<Transaction> {
    projectedEvidence(transaction: Transaction, reference: TargetLeaseEvidenceReference): TargetLeaseEvidence | undefined;
    projectEvidence(transaction: Transaction, evidence: TargetLeaseEvidence): TargetLeaseEvidence;
}
export interface AuthorityPermitIssueStore<Transaction> extends AuthorityPermitTransactionStore<Transaction>, AuthorityPermitEvidenceProjectionStore<Transaction> {
    issued(transaction: Transaction, nonce: string): AuthorityPermit | undefined;
    issue(transaction: Transaction, permit: AuthorityPermit): AuthorityPermit;
}
export declare class AuthorityPermitIssuer<Transaction> {
    private readonly store;
    constructor(store: AuthorityPermitIssueStore<Transaction>);
    issue(transaction: Transaction, request: TargetAuthorityPermitRequest, evidence: AuthorityCheckEvidence, issuedAt: Date): AuthorityPermit;
    private requireProjectedLeaseEvidence;
}
export declare abstract class AuthorityPermitAdmissionPort<Transaction> {
    abstract consume(transaction: Transaction, authentication: AuthenticatedAuthorityPermit, permit: AuthorityPermit, expected: AuthorityPermitExpectation, now: Date): void;
}
export declare class StoredAuthorityPermitAdmissionPort<Transaction> extends AuthorityPermitAdmissionPort<Transaction> {
    private readonly store;
    constructor(store: AuthorityPermitTargetAdmissionStore<Transaction>);
    consume(transaction: Transaction, authentication: AuthenticatedAuthorityPermit, permit: AuthorityPermit, expected: AuthorityPermitExpectation, now: Date): void;
}
export interface MemoryAuthorityPermitSnapshot {
    readonly version: 4;
    readonly projectedEvidence: readonly {
        readonly key: string;
        readonly bytes: Uint8Array;
    }[];
    readonly requested: readonly {
        readonly nonce: string;
        readonly bytes: Uint8Array;
    }[];
    readonly issued: readonly {
        readonly nonce: string;
        readonly bytes: Uint8Array;
    }[];
    readonly denied: readonly {
        readonly nonce: string;
        readonly bytes: Uint8Array;
    }[];
    readonly consumed: readonly {
        readonly nonce: string;
        readonly bytes: Uint8Array;
    }[];
}
export declare class MemoryAuthorityPermitTransaction {
    constructor();
}
export declare class MemoryAuthorityPermitStore implements AuthorityPermitTargetStore<MemoryAuthorityPermitTransaction>, AuthorityPermitIssueStore<MemoryAuthorityPermitTransaction> {
    #private;
    readonly owner: ActorRef;
    constructor(owner: ActorRef, snapshot?: MemoryAuthorityPermitSnapshot);
    transaction<Result>(operation: (transaction: MemoryAuthorityPermitTransaction) => Result, ..._guard: SynchronousResultGuard<Result>): Result;
    issued(transaction: MemoryAuthorityPermitTransaction, nonce: string): AuthorityPermit | undefined;
    projectedEvidence(transaction: MemoryAuthorityPermitTransaction, reference: TargetLeaseEvidenceReference): TargetLeaseEvidence | undefined;
    projectEvidence(transaction: MemoryAuthorityPermitTransaction, evidence: TargetLeaseEvidence): TargetLeaseEvidence;
    requested(transaction: MemoryAuthorityPermitTransaction, nonce: string): TargetAuthorityPermitRequest | undefined;
    consumed(transaction: MemoryAuthorityPermitTransaction, nonce: string): Digest | undefined;
    denied(transaction: MemoryAuthorityPermitTransaction, nonce: string): TargetAuthorityPermitDenial | undefined;
    request(transaction: MemoryAuthorityPermitTransaction, request: TargetAuthorityPermitRequest): TargetAuthorityPermitRequest;
    deny(transaction: MemoryAuthorityPermitTransaction, denial: TargetAuthorityPermitDenial): TargetAuthorityPermitDenial;
    issue(transaction: MemoryAuthorityPermitTransaction, permit: AuthorityPermit): AuthorityPermit;
    consume(transaction: MemoryAuthorityPermitTransaction, authentication: AuthenticatedAuthorityPermit, permit: AuthorityPermit, expected: AuthorityPermitExpectation, now: Date): void;
    snapshot(): MemoryAuthorityPermitSnapshot;
    private restore;
    private requireTransaction;
    private requireUnused;
    private requireRequestedExpectation;
    private decodeConsumed;
    private decodeDenied;
    private assertIssuedOwner;
    private assertRequestedOwner;
}
