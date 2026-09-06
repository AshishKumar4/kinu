import { type JsonValue } from "../core/index.js";
import { SurfaceId, type SlotCatalog, type SlotName } from "../facets/index.js";
import { View, type EventCursor, type JsonPatchEngine, type WorkspacePersistence } from "../workspaces/index.js";
import type { ControlTransaction } from "./facet-withdrawal.js";
export interface SurfaceAggregationInit<Transaction> {
    readonly persistence: WorkspacePersistence<Transaction>;
    readonly transaction: ControlTransaction<Transaction>;
    readonly patches: JsonPatchEngine;
    /** The §4.2 read path the parent composes its children through. */
    readonly catalog: SlotCatalog;
}
/** One child View an aggregating Surface composes, at the revision it is composing. */
export interface AggregatedChild {
    readonly surface: SurfaceId;
    readonly epoch: number;
    readonly revision: number;
    readonly body: JsonValue;
}
/**
 * SPEC §6.3 and §4.2: an aggregating Surface — a dashboard — composes the child Views its
 * slot-contributed entries name, and **drops the retired child's entry at its next
 * revision rather than composing a stale snapshot**.
 *
 * Dropping needs no liveness flag and no retirement notice. A child contributes exactly
 * what its stream currently answers: `currentSurfaceEpoch` returns the epoch a View
 * written now would belong to, so a retired child's last stream is behind that epoch and
 * a child that never rendered has not reached it. Either way the current View of that
 * epoch is absent, which is the same answer for both and the right one for the parent —
 * the terminal View stays exactly as readable as before for anyone asking about the child
 * itself.
 */
export declare class SurfaceAggregation<Transaction> {
    private readonly init;
    constructor(init: SurfaceAggregationInit<Transaction>);
    /**
     * The parent's next revision: exactly its live children, in canonical child order.
     * The slot query is awaited before the transaction opens, so the reads the composition
     * depends on and the write it produces stay one synchronous span (§8.5, §10.3).
     */
    advance(request: {
        readonly parent: SurfaceId;
        readonly slot: SlotName;
        readonly cursor: EventCursor;
    }): Promise<View>;
}
