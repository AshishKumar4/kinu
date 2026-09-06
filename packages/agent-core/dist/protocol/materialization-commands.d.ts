import type { ActorRef } from "../actors/index.js";
import { CodecDeclaration, Digest, Revision } from "../core/index.js";
import { MaterializationPlan } from "../definition/index.js";
import type { TenantId } from "../identity/index.js";
import type { CurrentLease, ProtocolCommand } from "./dispatcher.js";
import type { CommandEnvelope } from "./envelope.js";
import { type CommandPayloadCodec } from "./payload.js";
import { CommandCallerPolicy } from "./policy.js";
export declare const MATERIALIZATION_COMMANDS: Readonly<{
    applyLocal: "materialization.applyLocal";
}>;
export interface MaterializationApplyLocalPayload {
    readonly planId: Digest;
}
export interface MaterializationCommandBackend<Transaction, Read> {
    loadPlan(read: Read, planId: Digest): MaterializationPlan | undefined;
    loadPlanForApply(transaction: Transaction, planId: Digest): MaterializationPlan | undefined;
    currentRevision(read: Read, target: ActorRef, plan: MaterializationPlan): Revision | undefined;
    permitsApply(read: Read, target: ActorRef, plan: MaterializationPlan): boolean;
    applyLocal(transaction: Transaction, target: ActorRef, plan: MaterializationPlan, at: Date): Uint8Array;
}
export declare class MaterializationApplyLocalCommand<Transaction, Read> implements ProtocolCommand<Transaction, Read, MaterializationApplyLocalPayload> {
    private readonly backend;
    private readonly target;
    private readonly controller;
    private readonly tenant;
    readonly declaration: CodecDeclaration;
    readonly command: "materialization.applyLocal";
    readonly caller: CommandCallerPolicy;
    readonly expectedRevision: "required";
    readonly lease: "forbidden";
    readonly payload: CommandPayloadCodec<MaterializationApplyLocalPayload>;
    constructor(backend: MaterializationCommandBackend<Transaction, Read>, target: ActorRef, controller: ActorRef, tenant: TenantId);
    authorize(_read: Read, envelope: CommandEnvelope, payload: MaterializationApplyLocalPayload): boolean;
    permitsLifecycle(read: Read, _envelope: CommandEnvelope, payload: MaterializationApplyLocalPayload): boolean;
    currentRevision(read: Read, _envelope: CommandEnvelope, payload: MaterializationApplyLocalPayload): Revision | undefined;
    currentLease(_read: Read, _envelope: CommandEnvelope, _payload: MaterializationApplyLocalPayload, _at: Date): CurrentLease | undefined;
    execute(transaction: Transaction, _envelope: CommandEnvelope, payload: MaterializationApplyLocalPayload, at: Date): Uint8Array;
}
export declare const MaterializationCommandPayload: Readonly<{
    applyLocal(planId: Digest): Uint8Array;
}>;
