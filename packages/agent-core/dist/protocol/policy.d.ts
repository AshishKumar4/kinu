import type { ActorKind } from "../actors/index.js";
import type { CommandCaller } from "./envelope.js";
export declare abstract class CommandCallerPolicy {
    static principal(): CommandCallerPolicy;
    static actor(kind: ActorKind): CommandCallerPolicy;
    abstract admits(caller: CommandCaller): boolean;
}
