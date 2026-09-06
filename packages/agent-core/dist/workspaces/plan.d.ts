import { RecordCodec, Revision, type JsonValue } from "../core/index.js";
import { TurnId } from "../execution-references/index.js";
import { SurfaceId, TaskId } from "../facets/index.js";
import { type JsonObject } from "./codec.js";
import { EventCursor } from "./id.js";
import type { SurfaceEpoch } from "./surface-epoch.js";
import { ActionDescriptor, View } from "./view.js";
/**
 * SPEC §6.4. A plan is not a fourth kind of state: it is a left fold over Workspace Events
 * (§6.1) whose result renders as an ordinary §6.3 View. Three changes and no fourth — a task
 * enters the plan, a dependency is declared, a declared dependency is retracted — and each
 * change owns its own fold step, so admission and replay are one function rather than two
 * predicates that can disagree (C13-PLAN-ACYCLIC).
 */
export type PlanFactKind = "plan.taskDeclared" | "plan.dependencyDeclared" | "plan.dependencyRetracted";
export interface PlanEdge {
    readonly blocked: TaskId;
    readonly blockedBy: TaskId;
}
/** One folded fact together with the Event-log position it was read at. */
export interface PlanEntry {
    readonly fact: PlanFact;
    readonly cursor: EventCursor;
}
export declare abstract class PlanChange {
    static declaredTask(task: TaskId): PlanChange;
    static declaredDependency(blocked: TaskId, blockedBy: TaskId): PlanChange;
    static retractedDependency(blocked: TaskId, blockedBy: TaskId): PlanChange;
    static fromData(object: JsonObject): PlanChange;
    abstract readonly kind: PlanFactKind;
    /** The one fold step: an admission that would refuse is a replay that would refuse. */
    abstract fold(plan: TaskPlan): TaskPlan;
    abstract toData(): JsonObject;
}
/**
 * The decoded payload of one plan Event: what changed, and the Turn that appended it under
 * its own lease (§6.1 `self` tier). Identifiers only — no capability, BindingName,
 * ResourceCeiling, SecretRef, or Run reference is representable here, which is what keeps a
 * discovery from handing its successor more than the discoverer held.
 */
export declare class PlanFact {
    readonly change: PlanChange;
    readonly origin: TurnId;
    static get codec(): RecordCodec<PlanFact>;
    static encode(fact: PlanFact): Uint8Array;
    static decode(bytes: Uint8Array): PlanFact;
    static fromData(value: JsonValue): PlanFact;
    constructor(change: PlanChange, origin: TurnId);
    get kind(): PlanFactKind;
    fold(plan: TaskPlan): TaskPlan;
    toData(): JsonObject;
}
/**
 * The projection. Derived, rebuildable, and disposable (§8.4 rule 3): it holds identifiers
 * and edges, never a copy of the Task or Run state those identifiers name, and it has no
 * codec because nothing persists it — the Events it folds are the durable record
 * (C13-PLAN-PROJECTION).
 */
export declare class TaskPlan {
    static empty(cursor: EventCursor): TaskPlan;
    /** Rebuild from Events. One fold, so a rebuilt plan cannot differ from a grown one. */
    static replay(start: EventCursor, entries: readonly PlanEntry[]): TaskPlan;
    readonly tasks: readonly TaskId[];
    readonly dependencies: readonly PlanEdge[];
    readonly cursor: EventCursor;
    private constructor();
    /** One appended Event: the fact's own fold step, then the cursor it was read at. */
    advance(fact: PlanFact, cursor: EventCursor): TaskPlan;
    declares(task: TaskId): boolean;
    dependsDirectly(edge: PlanEdge): boolean;
    /** Whether `earlier` must happen before `later` under the standing edges. */
    precedes(earlier: TaskId, later: TaskId): boolean;
    /** The tasks this task directly blocks. */
    blocking(task: TaskId): readonly TaskId[];
    /** The tasks that directly block this task. */
    blockers(task: TaskId): readonly TaskId[];
    withTasks(tasks: readonly TaskId[]): TaskPlan;
    withDependencies(dependencies: readonly PlanEdge[]): TaskPlan;
}
/**
 * The longest chain of declared dependencies, in the order the work has to happen. Pure and
 * total over the projection and stored nowhere, so it can never disagree with the edges it
 * summarizes; ties break by canonical TaskId order so the answer is one path rather than a
 * set of equally long ones (C13-PLAN-CRITICAL-PATH).
 */
export declare function criticalPath(plan: TaskPlan): readonly TaskId[];
/**
 * One rendered snapshot of the plan on a Surface. The body is identifiers, standing edges,
 * and the recomputed critical path — data the §6.3 no-live-state rule accepts unchanged —
 * and the projection's cursor is the View's resume position.
 */
export declare function planView(surface: SurfaceId, epoch: SurfaceEpoch, revision: Revision, plan: TaskPlan, actions?: readonly ActionDescriptor[]): View;
export declare function planViewBody(plan: TaskPlan): JsonValue;
/**
 * A discovery is attributable to exactly the Turn that appended it, and to no other. The fact
 * carries identifiers only, so there is no field in which a discoverer could widen what its
 * successor receives; that leaves only the origin to check (C13-PLAN-DECLARER-BOUNDED).
 */
export declare function requireDeclaringTurn(fact: PlanFact, turn: TurnId): void;
