import type { ActorActivationStore, ActorStore } from "./store.js";
import { ActorRef } from "./types.js";
export interface ActorContext<TTransaction> {
    readonly actor: ActorRef;
    readonly store: ActorActivationStore<TTransaction>;
}
export declare function isActorActivationStore<TTransaction>(store: ActorStore<TTransaction>): store is ActorActivationStore<TTransaction>;
export declare function createActorContext<TTransaction>(actor: ActorRef, store: ActorStore<TTransaction>): ActorContext<TTransaction>;
