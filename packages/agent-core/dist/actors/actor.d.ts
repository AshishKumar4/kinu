import { CodecDeclaration } from "../core/index.js";
import { AgentCoreError, type AgentCoreErrorCode } from "../errors.js";
import { type ActorContext } from "./context.js";
import type { ActorId } from "./id.js";
import { type ActorStartOperation } from "./store.js";
import { ActorFence } from "./types.js";
import type { ActorCommand, ActorRef, SynchronousResultGuard } from "./types.js";
interface ActorCommitUnknownErrorCodeDependency {
    readonly requested: "actor.commit-unknown";
    readonly fallback: Extract<AgentCoreErrorCode, "actor.closed">;
}
export declare class ActorCommitUnknownError extends AgentCoreError {
    static readonly codeDependency: ActorCommitUnknownErrorCodeDependency;
    constructor(message?: string);
}
export declare abstract class Actor<TTransaction> {
    #private;
    /**
     * Subclasses declare only the record codecs they own. Actor unions the stable recovery
     * carrier itself, so no subclass can omit it or choose its version. The stored
     * declaration sits in a separate raw carrier that the store returns before `start`
     * decodes domain records; an incompatible or malformed future carrier therefore leaves
     * construction possible and refuses every operation instead.
     */
    protected constructor(context: ActorContext<TTransaction>, declaration: CodecDeclaration, start: ActorStartOperation<TTransaction>);
    get id(): ActorId;
    get ref(): ActorRef;
    protected execute<TResult>(command: ActorCommand<TTransaction, TResult>, ...guard: SynchronousResultGuard<TResult>): Promise<TResult>;
    protected executeFenced<TResult>(fence: ActorFence, command: ActorCommand<TTransaction, TResult>, ...guard: SynchronousResultGuard<TResult>): Promise<TResult>;
    currentFence(): Promise<ActorFence>;
    close(): Promise<void>;
    protected advanceFence(): Promise<ActorFence>;
    private advanceCurrentFence;
    private mutate;
    private requireCurrentState;
    private enqueueCommand;
    private enqueue;
    private transact;
    private ensureAccepting;
    private ensureActive;
}
export {};
