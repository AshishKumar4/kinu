import { DetachedEffectExecution, type DetachedEffectExecutionPersistence } from "./detached-execution.js";
import type { EffectAttemptId } from "./id.js";
export interface DetachedEffectExecutionMemoryState {
    readonly detachedExecutions: Map<string, Uint8Array>;
}
export declare function createDetachedEffectExecutionMemoryState(): DetachedEffectExecutionMemoryState;
export declare function cloneDetachedEffectExecutionMemoryState(state: DetachedEffectExecutionMemoryState): DetachedEffectExecutionMemoryState;
/**
 * The in-memory reference store for detached execution records (§8.4's memory implementation
 * of one substrate seam). Records are held as codec bytes, so a suite that clones the state
 * gets the same snapshot-and-restart behavior a substrate gives and cannot share a live object
 * across the boundary.
 */
export declare class MemoryDetachedEffectExecutionPersistence implements DetachedEffectExecutionPersistence<DetachedEffectExecutionMemoryState> {
    detachedExecution(transaction: DetachedEffectExecutionMemoryState, attempt: EffectAttemptId): DetachedEffectExecution | undefined;
    releasedDetachedExecutions(transaction: DetachedEffectExecutionMemoryState, limit: number): readonly DetachedEffectExecution[];
    appendDetachedExecution(transaction: DetachedEffectExecutionMemoryState, record: DetachedEffectExecution): void;
}
