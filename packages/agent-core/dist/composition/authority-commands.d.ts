import type { ActorRef } from "../actors/index.js";
import { AuthorityCheckEvidence, AuthorityCheckRequest, BindingValidationEvidence, BindingValidationRequest, TargetLeaseEvidence, type TenantAuthorityPermitStore } from "../authority/index.js";
import type { TransientContentAccess } from "../content/index.js";
import type { PrincipalRef } from "../identity/index.js";
import { AuthorityPermitIssuanceReply, AuthorityPermitIssuanceRequest, CommandAuthenticator, type CommandDispatchResult, type CommandIngressResult, type CurrentLease } from "../protocol/index.js";
import { type ClosedCommandFamilies, type ClosedDispatcherInit } from "./dispatcher.js";
export declare const TENANT_AUTHORITY_COMMANDS: Readonly<{
    validateBinding: "binding.validate";
    check: "authority.check";
    projectLeaseEvidence: "authority.permit.evidence.project";
    issuePermit: "authority.permit.issue";
}>;
export interface TenantAuthorityCommandBackend<Transaction, Read> {
    actorFence(read: Read, actor: ActorRef): number | undefined;
    checkPrincipal(read: Read, request: AuthorityCheckRequest): PrincipalRef | undefined;
    currentCheckLease(read: Read, request: AuthorityCheckRequest, at: Date): CurrentLease | undefined;
    projectLeaseEvidence(transaction: Transaction, evidence: TargetLeaseEvidence, at: Date): TargetLeaseEvidence;
    validateBinding(transaction: Transaction, request: BindingValidationRequest, at: Date): BindingValidationEvidence;
    check(transaction: Transaction, request: AuthorityCheckRequest, at: Date): AuthorityCheckEvidence;
    issuePermit(transaction: Transaction, request: AuthorityPermitIssuanceRequest, at: Date): AuthorityPermitIssuanceReply;
}
export declare abstract class TenantAuthorityCommandStatePort<Read> {
    abstract actorFence(read: Read, actor: ActorRef): number | undefined;
    abstract checkPrincipal(read: Read, request: AuthorityCheckRequest): PrincipalRef | undefined;
    abstract currentCheckLease(read: Read, request: AuthorityCheckRequest, at: Date): CurrentLease | undefined;
}
export declare class TenantAuthorityRuntimeCommandBackend<Transaction, Read> implements TenantAuthorityCommandBackend<Transaction, Read> {
    #private;
    private readonly state;
    private readonly authority;
    private readonly issuerActor;
    constructor(state: TenantAuthorityCommandStatePort<Read>, authority: TenantAuthorityPermitStore<Transaction>, issuerActor: ActorRef);
    actorFence(read: Read, actor: ActorRef): number | undefined;
    get transactionStore(): TenantAuthorityPermitStore<Transaction>;
    checkPrincipal(read: Read, request: AuthorityCheckRequest): PrincipalRef | undefined;
    currentCheckLease(read: Read, request: AuthorityCheckRequest, at: Date): CurrentLease | undefined;
    projectLeaseEvidence(transaction: Transaction, evidence: TargetLeaseEvidence, _at: Date): TargetLeaseEvidence;
    validateBinding(transaction: Transaction, request: BindingValidationRequest, at: Date): BindingValidationEvidence;
    check(transaction: Transaction, request: AuthorityCheckRequest, at: Date): AuthorityCheckEvidence;
    issuePermit(transaction: Transaction, request: AuthorityPermitIssuanceRequest, at: Date): AuthorityPermitIssuanceReply;
    private runtime;
}
type AdditionalTenantCommandFamilies<Transaction, Read> = Omit<ClosedCommandFamilies<Transaction, Read>, "authority">;
export type ClosedTenantAuthorityCompositionInit<Transaction, Read, ReadTransaction = Transaction, Transport = unknown> = Omit<ClosedDispatcherInit<Transaction, Read, ReadTransaction>, "commands"> & {
    readonly backend: TenantAuthorityCommandBackend<Transaction, Read>;
    readonly authenticator: CommandAuthenticator<Transport>;
    readonly content: TransientContentAccess;
    readonly commands?: AdditionalTenantCommandFamilies<Transaction, Read>;
    readonly leaseForMilliseconds: number;
};
export declare class ClosedTenantAuthorityComposition<Transaction, Read, ReadTransaction = Transaction, Transport = unknown> {
    #private;
    constructor(init: ClosedTenantAuthorityCompositionInit<Transaction, Read, ReadTransaction, Transport>);
    accept(envelope: Uint8Array, transport: Transport, submittedBytes?: Uint8Array): Promise<CommandIngressResult>;
    dispatch(envelope: Uint8Array, transport: Transport, submittedBytes?: Uint8Array): Promise<CommandDispatchResult>;
}
export declare function createClosedTenantAuthorityComposition<Transaction, Read, ReadTransaction = Transaction, Transport = unknown>(init: ClosedTenantAuthorityCompositionInit<Transaction, Read, ReadTransaction, Transport>): ClosedTenantAuthorityComposition<Transaction, Read, ReadTransaction, Transport>;
export {};
