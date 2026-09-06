import type { FacetData } from "./data.js";
import { InterceptorId } from "./id.js";
import { OperationSelector } from "./mapping.js";
/** The cut points whose value in flight belongs to one Operation of one target Facet. */
export type OperationCutPoint = "operation.before" | "operation.after";
/**
 * The cut points whose value in flight belongs to a Turn rather than to an Operation
 * (SPEC §4.4). The distinction is drawn once, here, because three separate rules turn on
 * it: the context carries a Turn instead of an Operation, an `OperationSelector` has
 * nothing to select, and cross-facet opt-in cannot scope what has no target.
 */
export type TurnBoundCutPoint = "prompt.assemble" | "input.submitted" | "turn.step";
export type CutPoint = OperationCutPoint | TurnBoundCutPoint;
export type InterceptorMode = "rewrite" | "gate";
export declare const TURN_BOUND_CUT_POINTS: readonly TurnBoundCutPoint[];
export declare function isTurnBoundCutPoint(cutPoint: CutPoint): cutPoint is TurnBoundCutPoint;
export declare class InterceptorDeclaration {
    readonly id: InterceptorId;
    readonly cutPoint: CutPoint;
    readonly mode: InterceptorMode;
    readonly modeRank: number;
    readonly appliesTo: OperationSelector;
    readonly priority: number;
    constructor(id: InterceptorId, cutPoint: CutPoint, mode: InterceptorMode, ...selection: [appliesTo: OperationSelector, priority: number] | [priority: number]);
    static fromData(payload: FacetData): InterceptorDeclaration;
    static encode(interceptor: InterceptorDeclaration): Uint8Array;
    static decode(bytes: Uint8Array): InterceptorDeclaration;
    toData(): FacetData;
}
