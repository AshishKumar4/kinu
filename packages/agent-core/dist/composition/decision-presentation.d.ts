import type { OperationContext, Surface } from "../facets/index.js";
import type { PreparedInvocation } from "../invocations/index.js";
import { type Event, type EventCursor, type JsonPatchEngine, type View, type WorkspacePersistence } from "../workspaces/index.js";
import type { ControlTransaction } from "./facet-withdrawal.js";
export interface DecisionPresentationInit<Transaction> {
    readonly persistence: WorkspacePersistence<Transaction>;
    readonly transaction: ControlTransaction<Transaction>;
    readonly patches: JsonPatchEngine;
}
export interface DecisionPresentationRequest<Lease, Authority, Domain, PathEpochs> {
    /** The §4 Surface whose render answer this presentation constrains. */
    readonly surface: Surface;
    readonly context: OperationContext;
    /** The §7.3 prepared intent the decision authorizes, and the item being decided. */
    readonly prepared: PreparedInvocation<Lease, Authority, Domain, PathEpochs>;
    readonly itemIndex: number;
    /**
     * The Event the decided arguments arrived on, when they arrived on one. Its
     * host-derived tier is what every mark carries. Absent means the Turn executor
     * assembled them under its own lease, which §6.1 tiers `self`.
     */
    readonly arrival?: Event | undefined;
    readonly cursor: EventCursor;
}
/**
 * SPEC §6.3 and §7.3: the one production path from a prepared intent to a decision View.
 *
 * It spans three planes and belongs to none of them, which is why it lives here. The
 * Surface (§4) renders, and its answer is generic `FacetData` that has to decode to a
 * `DecisionRendering` before it can mean anything. The prepared intent (§7.3) supplies
 * both the digest the decision authorizes and the values it is about, so a Surface can
 * only name positions in an intent it did not write. The Workspace plane (§6.3) composes
 * the marks from the arrival record's host-derived tier and publishes the revision.
 *
 * The render is awaited before the transaction opens, so the guarded read and write stay
 * one synchronous span (§8.5, §10.3).
 */
export declare class DecisionSurfacePresentation<Transaction> {
    private readonly init;
    constructor(init: DecisionPresentationInit<Transaction>);
    present<Lease, Authority, Domain, PathEpochs>(request: DecisionPresentationRequest<Lease, Authority, Domain, PathEpochs>): Promise<View>;
}
