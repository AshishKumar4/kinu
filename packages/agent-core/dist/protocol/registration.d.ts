import type { CodecDeclaration, Revision } from "../core/index.js";
import type { CommandEnvelope } from "./envelope.js";
import type { CommandPayloadCodec } from "./payload.js";
import type { CommandCallerPolicy } from "./policy.js";
type CommandFieldPolicy = "required" | "optional" | "forbidden";
export type ExpectedRevisionPolicy = CommandFieldPolicy;
export type LeaseTokenPolicy = CommandFieldPolicy;
export interface CurrentLease {
    readonly turn: NonNullable<CommandEnvelope["lease"]>["turn"];
    readonly holder: NonNullable<CommandEnvelope["lease"]>["holder"] | undefined;
    readonly epoch: number;
    readonly expiresAt: Date | undefined;
}
export interface ProtocolValueCodec<Value> {
    encode(value: Value): Uint8Array;
    decode(bytes: Uint8Array): Value;
}
export interface ProtocolCommandExecution<Reply, Observation> {
    readonly outcome: "committed" | "rejectedAuthority";
    readonly reply: Reply;
    readonly observation?: Observation;
}
export interface ProtocolCommandRegistration<Transaction, Read, Request = unknown, Reply = Uint8Array, Observation = never> {
    readonly command: string;
    readonly caller: CommandCallerPolicy;
    readonly expectedRevision: ExpectedRevisionPolicy;
    readonly lease: LeaseTokenPolicy;
    readonly payload: CommandPayloadCodec<Request>;
    readonly replyCodec?: ProtocolValueCodec<Reply>;
    readonly observationCodec?: ProtocolValueCodec<Observation>;
    /**
     * The record kinds this command's own execution writes, at the codec versions it
     * writes them under (§8.3). A dispatcher declares the write record and the audit
     * record it owns itself and the Actor adds the recovery carrier, so without this a
     * Run commit, a slot entry or a materialization plan sits inside the record set the
     * §8.3 gate protects and outside the declaration a reader compares against. The
     * member is required rather than optional: a command that declares nothing would
     * read as a command that owns no records, which is a claim only an empty
     * `CodecDeclaration` may make explicitly.
     */
    readonly declaration: CodecDeclaration;
    authorize(read: Read, envelope: CommandEnvelope, payload: Request): boolean;
    permitsLifecycle(read: Read, envelope: CommandEnvelope, payload: Request): boolean;
    currentRevision(read: Read, envelope: CommandEnvelope, payload: Request): Revision | undefined;
    currentLease(read: Read, envelope: CommandEnvelope, payload: Request, at: Date): CurrentLease | undefined;
    execute(transaction: Transaction, envelope: CommandEnvelope, payload: Request, at: Date): Uint8Array | ProtocolCommandExecution<Reply, Observation>;
}
export type ProtocolCommand<Transaction, Read, Request = unknown, Reply = Uint8Array, Observation = never> = ProtocolCommandRegistration<Transaction, Read, Request, Reply, Observation>;
export {};
