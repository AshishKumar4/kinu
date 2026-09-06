import type { TransientContentAccess } from "../content/index.js";
import { CommandAuthenticator } from "./authentication.js";
import { type CommandDispatcher, type CommandDispatchResult } from "./dispatcher.js";
export type PreDispatchPhase = "admissionPreflight" | "dispatch";
export type CommitCertainty = "notAttempted" | "rolledBack" | "unknown";
export type RetryInstruction = "mayRetry" | "retrySameKey";
export interface PreDispatchFailure {
    readonly kind: "preDispatchFailure";
    readonly phase: PreDispatchPhase;
    readonly commit: CommitCertainty;
    readonly retry: RetryInstruction;
    readonly cause: unknown;
}
export type CommandIngressResult = CommandDispatchResult | PreDispatchFailure;
export interface CommandIngressInit<Transaction, Read, ReadTransaction = Transaction, Transport = unknown> {
    readonly dispatcher: CommandDispatcher<Transaction, Read, ReadTransaction>;
    readonly content: TransientContentAccess;
    readonly authenticator?: CommandAuthenticator<Transport>;
    readonly leaseForMilliseconds?: number;
    readonly now?: () => Date;
}
export declare class CommandIngress<Transaction, Read, ReadTransaction = Transaction, Transport = unknown> {
    #private;
    constructor(init: CommandIngressInit<Transaction, Read, ReadTransaction, Transport>);
    accept(rawEnvelope: Uint8Array, transport: Transport, submittedBytes?: Uint8Array): Promise<CommandIngressResult>;
    private prepare;
}
