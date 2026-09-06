import { RecordCodec } from "../core/index.js";
import { ActorFence, ActorRef } from "./types.js";
export declare class ActorRecoveryState {
    readonly actor: ActorRef;
    readonly epoch: number;
    readonly recoveries: number;
    static get codec(): RecordCodec<ActorRecoveryState>;
    constructor(actor: ActorRef, epoch: number, recoveries: number);
    static initial(actor: ActorRef): ActorRecoveryState;
    static encode(state: ActorRecoveryState): Uint8Array;
    static decode(bytes: Uint8Array): ActorRecoveryState;
    get fence(): ActorFence;
    recover(): ActorRecoveryState;
    advance(): ActorRecoveryState;
}
