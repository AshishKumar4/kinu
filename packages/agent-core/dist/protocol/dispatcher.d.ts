import { Actor, ActorCommitUnknownError, type ActorLocalStore, type ActorRef } from "../actors/index.js";
import { AgentCoreError } from "../errors.js";
import type { TenantId } from "../identity/index.js";
import { AuditRecord, CorrelationId, type AuditAppendContext, type AuditRecordId, type InvocationId, type WriteRecordId } from "../invocations/index.js";
import { type CommandAuthentication } from "./authentication.js";
import { type CommandCaller, type CommandEnvelope } from "./envelope.js";
import { type PreparedCommandPayload } from "./payload.js";
import type { ProtocolCommand } from "./registration.js";
import { WriteRecord, type CommandOutcome } from "./write.js";
export type { CurrentLease, ExpectedRevisionPolicy, LeaseTokenPolicy, ProtocolCommand } from "./registration.js";
export interface CommandIdentity {
    readonly caller: CommandCaller;
    readonly idempotencyKey: string;
}
export interface ProtocolPersistence<Transaction> {
    repair?(transaction: Transaction): void;
    findWrite(transaction: Transaction, identity: CommandIdentity): WriteRecord | undefined;
    findAudit(transaction: Transaction, id: AuditRecordId): AuditRecord | undefined;
    appendAudit(transaction: Transaction, record: AuditRecord, context?: AuditAppendContext): void;
    appendWrite(transaction: Transaction, record: WriteRecord): void;
}
export interface ProtocolIdFactory<Transaction> {
    writeRecordId(transaction: Transaction): WriteRecordId;
    auditRecordId(transaction: Transaction): AuditRecordId;
    invocationId(transaction: Transaction): InvocationId;
    correlationId(transaction: Transaction): CorrelationId;
}
export interface CommandProtocolLimits {
    readonly envelopeBytes: number;
    readonly payloadBytes: number;
}
export interface CommandDispatcherInit<Transaction, Read, ReadTransaction = Transaction> {
    readonly store: ActorLocalStore<Transaction, ReadTransaction>;
    readonly persistence: ProtocolPersistence<Transaction>;
    readonly ids: ProtocolIdFactory<Transaction>;
    readonly actor: ActorRef;
    readonly tenant: TenantId;
    readonly readOnly: (transaction: ReadTransaction) => Read;
    readonly commands: readonly RegisteredProtocolCommand<Transaction, Read>[];
    readonly limits: CommandProtocolLimits;
    readonly now?: () => Date;
}
export interface CommandDispatchResult {
    readonly kind: "commandOutcome";
    readonly outcome: CommandOutcome;
    readonly reply: Uint8Array;
    readonly observation?: Uint8Array;
    readonly write: WriteRecord;
}
export type CommandAdmission = CompletedCommandAdmission | PreparedCommandAdmission;
export interface CompletedCommandAdmission {
    readonly kind: "completed";
    readonly result: CommandDispatchResult;
}
export interface PreparedCommandAdmission {
    readonly kind: "prepare";
    dispatch(payload: PreparedCommandPayload): Promise<CommandDispatchResult>;
}
export declare class CommandCommitUnknownError extends ActorCommitUnknownError {
    readonly retrySameKey: boolean;
    constructor(message?: string, retrySameKey?: boolean);
}
export declare class CommandPreparationUnavailableError extends AgentCoreError {
    constructor(message?: string);
}
export declare class CommandDispatcher<Transaction, Read, ReadTransaction = Transaction> extends Actor<Transaction> {
    #private;
    constructor(init: CommandDispatcherInit<Transaction, Read, ReadTransaction>);
    get actor(): ActorRef;
    get tenant(): TenantId;
    get limits(): CommandProtocolLimits;
    decodeForPreparation(rawEnvelope: Uint8Array): CommandEnvelope | undefined;
    decodeForAuthentication(rawEnvelope: Uint8Array): CommandEnvelope | undefined;
    admit(rawEnvelope: Uint8Array, authentication: CommandAuthentication | undefined): Promise<CommandAdmission>;
    private admitInTransaction;
    private dispatchPrepared;
    private dispatchPreparedInTransaction;
    private validate;
    private decode;
    private prepareDecision;
    private persistDecision;
    private hasInvalidCallerCause;
    private usableCause;
    private requireAudit;
    private appendAudit;
    private readForGate;
    private booleanGate;
    private timestamp;
}
/**
 * A command as the dispatcher holds it. The dispatcher routes payloads and replies
 * through each command's own codecs without ever naming their types, so a registry
 * mixes commands whose request, reply, and observation types differ; the defaults on
 * ProtocolCommand describe one command, never a heterogeneous family.
 */
export type RegisteredProtocolCommand<Transaction, Read> = ProtocolCommand<Transaction, Read, unknown, unknown, unknown>;
