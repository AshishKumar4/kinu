import { InvocationId } from "../interaction-references/index.js";
import type { CommandCallerPolicy, CommandEnvelope, CurrentLease, ProtocolCommand, ProtocolCommandExecution, ProtocolValueCodec } from "../protocol/index.js";
import { type FacetDataMap } from "../facets/index.js";
export declare const INVOCATION_COMMANDS: Readonly<{
    prepareExecutor: "invocation.prepare.executor";
    prepareOwner: "invocation.prepare.owner";
    resolveApproval: "invocation.approval.resolve";
    claimExecutor: "invocation.item.claim.executor";
    claimSystem: "invocation.item.claim.system";
    recoverExecutor: "invocation.item.recover.executor";
    recoverSystem: "invocation.item.recover.system";
    attemptExecutor: "invocation.attempt.append.executor";
    attemptSystem: "invocation.attempt.append.system";
    preEffectReceipt: "invocation.receipt.preEffect";
    attemptReceipt: "invocation.receipt.attempt";
    reconcileReceipt: "invocation.receipt.reconcile";
}>;
export type InvocationCommandName = (typeof INVOCATION_COMMANDS)[keyof typeof INVOCATION_COMMANDS];
export interface InvocationCommandPayloadValue {
    readonly invocation: InvocationId;
    readonly body: FacetDataMap;
}
export interface InvocationCommandBackend<Transaction, Read, Reply, Observation> {
    readonly replyCodec: ProtocolValueCodec<Reply>;
    readonly observationCodec: ProtocolValueCodec<Observation>;
    authorize(command: InvocationCommandName, read: Read, envelope: CommandEnvelope, payload: InvocationCommandPayloadValue): boolean;
    permitsLifecycle(command: InvocationCommandName, read: Read, envelope: CommandEnvelope, payload: InvocationCommandPayloadValue): boolean;
    currentLease(command: InvocationCommandName, read: Read, envelope: CommandEnvelope, payload: InvocationCommandPayloadValue, at: Date): CurrentLease | undefined;
    execute(command: InvocationCommandName, transaction: Transaction, envelope: CommandEnvelope, payload: InvocationCommandPayloadValue, at: Date): ProtocolCommandExecution<Reply, Observation>;
}
export interface InvocationCommandCallerPolicies {
    readonly executor: CommandCallerPolicy;
    readonly owner: CommandCallerPolicy;
    readonly approver: CommandCallerPolicy;
    readonly system: CommandCallerPolicy;
}
export declare function createInvocationProtocolCommands<Transaction, Read, Reply, Observation>(backend: InvocationCommandBackend<Transaction, Read, Reply, Observation>, callers: InvocationCommandCallerPolicies): readonly ProtocolCommand<Transaction, Read, InvocationCommandPayloadValue, Reply, Observation>[];
export declare const InvocationCommandPayload: Readonly<{
    encode(invocation: InvocationId, body: FacetDataMap): Uint8Array;
}>;
