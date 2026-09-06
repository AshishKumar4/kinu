import { RecordCodec } from "../core/index.js";
import { TurnId } from "../execution-references/index.js";
import { EventId } from "../interaction-references/index.js";
import { InboxReferenceId } from "./id.js";
export interface InboxEventReferenceInit {
    readonly id: InboxReferenceId;
    readonly turn: TurnId;
    readonly event: EventId;
    readonly sequence: number;
    readonly leaseEpoch: number;
}
export declare class InboxEventReference {
    static get codec(): RecordCodec<InboxEventReference>;
    static encode(reference: InboxEventReference): Uint8Array;
    static decode(bytes: Uint8Array): InboxEventReference;
    readonly init: InboxEventReferenceInit;
    constructor(init: InboxEventReferenceInit);
    get id(): InboxReferenceId;
    get turn(): TurnId;
    get event(): EventId;
    get sequence(): number;
    get leaseEpoch(): number;
}
