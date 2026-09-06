import { ContentRef, type ContentRetentionField, RecordCodec, Revision } from "../core/index.js";
import { EnvironmentId, EnvironmentSessionId, EnvironmentSnapshotId } from "./id.js";
export type EnvironmentSnapshotStateName = "creating" | "ready" | "failed";
export declare abstract class EnvironmentSnapshotState {
    static get creating(): EnvironmentSnapshotState;
    static get ready(): EnvironmentSnapshotState;
    static get failed(): EnvironmentSnapshotState;
    abstract readonly name: EnvironmentSnapshotStateName;
    ready(): EnvironmentSnapshotState;
    fail(): EnvironmentSnapshotState;
    protected invalid(operation: string): never;
}
export declare class EnvironmentSnapshot {
    readonly id: EnvironmentSnapshotId;
    readonly environmentId: EnvironmentId;
    readonly sessionId: EnvironmentSessionId;
    readonly environmentRevision: Revision;
    readonly generation: number;
    readonly sessionEpoch: number;
    readonly state: EnvironmentSnapshotState;
    readonly content: ContentRef | undefined;
    readonly recordRevision: Revision;
    static get codec(): RecordCodec<EnvironmentSnapshot>;
    constructor(id: EnvironmentSnapshotId, environmentId: EnvironmentId, sessionId: EnvironmentSessionId, environmentRevision: Revision, generation: number, sessionEpoch: number, state: EnvironmentSnapshotState, content: ContentRef | undefined, recordRevision: Revision);
    static encode(snapshot: EnvironmentSnapshot): Uint8Array;
    static decode(bytes: Uint8Array): EnvironmentSnapshot;
    ready(content: ContentRef): EnvironmentSnapshot;
    fail(): EnvironmentSnapshot;
    private transition;
}
/**
 * The captured state bytes a snapshot holds (§8.4). A snapshot advances through its record
 * revisions in place, so a capture that replaces earlier content releases the ContentRef the
 * stored revision named before retaining the new one.
 */
export declare function environmentSnapshotContentRetention(value: EnvironmentSnapshot): readonly ContentRetentionField[];
