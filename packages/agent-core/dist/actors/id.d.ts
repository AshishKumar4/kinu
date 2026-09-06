import { TextId } from "../core/index.js";
export declare class ActorId extends TextId {
    constructor(value: string);
}
export declare function isExactActorId(value: unknown): value is ActorId;
