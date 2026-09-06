import type { JsonValue } from "../../core/index.js";
import { RunId } from "../../execution-references/index.js";
import { Contributions, OperationDescriptor, SurfaceDescriptor } from "../contribution.js";
import { EventDeclaration, EventPattern } from "../event.js";
import { OperationName } from "../id.js";
import type { FacetManifest } from "../manifest.js";
import { DetailedProfileError, InternalProfileFacetRuntime, ProfileControlContract, ProfileEventContract, ProfileOperationContract, type ProtectedProfileRuntimePort, type PublicProfileInput } from "../profile-runtime/index.js";
import { TaskId } from "./id.js";
export interface TaskActionSubmitted extends PublicProfileInput {
    readonly kind: "task.actionSubmitted";
    readonly taskId: TaskId;
    readonly action: JsonValue;
}
export interface TaskUpdate {
    readonly parentId?: TaskId | null;
    readonly runId?: RunId | null;
    readonly attributes?: JsonValue;
}
export interface TaskCreateInput extends PublicProfileInput {
    readonly task: TaskEntry;
}
export interface TaskUpdateInput extends PublicProfileInput {
    readonly id: TaskId;
    readonly update: TaskUpdate;
}
export interface TaskListInput extends PublicProfileInput {
}
export interface TaskActionInput extends PublicProfileInput {
    readonly taskId: TaskId;
    readonly action: JsonValue;
}
export declare class TaskEntry {
    readonly id: TaskId;
    readonly parentId: TaskId | undefined;
    readonly runId: RunId | undefined;
    readonly attributes: JsonValue;
    constructor(id: TaskId, parentId: TaskId | undefined, runId: RunId | undefined, attributes: JsonValue);
    revise(update: TaskUpdate): TaskEntry;
}
export declare const TASK_OPERATION_CONTRACTS: Readonly<{
    create: ProfileOperationContract<"create", TaskCreateInput, void, "output">;
    update: ProfileOperationContract<"update", TaskUpdateInput, TaskEntry, "output">;
    list: ProfileOperationContract<"list", TaskListInput, readonly TaskEntry[], "output">;
}>;
export declare const TASK_OPERATIONS: readonly OperationDescriptor[];
export declare const TASK_BOARD_SURFACE: SurfaceDescriptor;
export declare const TASK_ACTION_EVENT: EventDeclaration;
export declare const TASK_ACTION_EVENT_CONTRACT: ProfileEventContract<"task.actionSubmitted", TaskActionSubmitted>;
export declare const TASK_ACTION_CONTROL: ProfileControlContract<"task.submitAction", TaskActionInput, void>;
export declare const TASK_ACTION_SOURCE_OPERATION: ProfileOperationContract<"task.submitAction", TaskActionInput, void, "output">;
export declare const TASK_ACTION_SUBSCRIPTION: Readonly<{
    source: EventPattern;
    target: OperationName;
}>;
export declare const TASK_CONTRIBUTIONS: Contributions;
export declare class TaskBackend {
    #private;
    create(task: TaskEntry): void;
    update(id: TaskId, update: TaskUpdate): TaskEntry;
    list(): readonly TaskEntry[];
    assertExists(id: TaskId): void;
}
export declare class TaskFacet<Receipt> {
    private readonly runtime;
    private readonly backend;
    static readonly operations: readonly OperationDescriptor[];
    static readonly surface: SurfaceDescriptor;
    static readonly events: readonly EventDeclaration[];
    static readonly subscriptions: readonly Readonly<{
        source: EventPattern;
        target: OperationName;
    }>[];
    constructor(runtime: ProtectedProfileRuntimePort<Receipt>, backend: TaskBackend);
    asInternalRuntime(manifest: FacetManifest): InternalProfileFacetRuntime;
    create(input: TaskCreateInput): Promise<void>;
    update(input: TaskUpdateInput): Promise<TaskEntry>;
    list(input?: TaskListInput): Promise<readonly TaskEntry[]>;
    submitAction(input: TaskActionInput): Promise<void>;
}
export type TaskErrorCode = "task.exists" | "task.not-found" | "task.parent" | "task.cycle";
export declare class TaskError extends DetailedProfileError<TaskErrorCode> {
    constructor(detailCode: TaskErrorCode, message: string);
}
export declare function validateTaskHierarchy(tasks: ReadonlyMap<string, TaskEntry>): void;
