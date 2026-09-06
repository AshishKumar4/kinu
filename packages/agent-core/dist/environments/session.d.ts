import { RecordCodec, Revision } from "../core/index.js";
import { EnvironmentId, EnvironmentSessionId, EnvironmentSnapshotId } from "./id.js";
export type EnvironmentSessionStateName = "reserved" | "opening" | "open" | "lost" | "failed" | "closing" | "closed";
export declare abstract class EnvironmentSessionState {
    static get reserved(): EnvironmentSessionState;
    static get opening(): EnvironmentSessionState;
    static get open(): EnvironmentSessionState;
    static get lost(): EnvironmentSessionState;
    static get failed(): EnvironmentSessionState;
    static get closing(): EnvironmentSessionState;
    static get closed(): EnvironmentSessionState;
    abstract readonly name: EnvironmentSessionStateName;
    beginOpen(): EnvironmentSessionState;
    opened(): EnvironmentSessionState;
    failOpen(): EnvironmentSessionState;
    lost(): EnvironmentSessionState;
    beginClose(): EnvironmentSessionState;
    closed(): EnvironmentSessionState;
    assertUsable(): void;
    protected invalid(operation: string): never;
}
export declare class EnvironmentSessionCapability {
    readonly environmentId: EnvironmentId;
    readonly sessionId: EnvironmentSessionId;
    readonly environmentRevision: Revision;
    readonly epoch: number;
    constructor(environmentId: EnvironmentId, sessionId: EnvironmentSessionId, environmentRevision: Revision, epoch: number);
}
export declare class EnvironmentSession {
    readonly id: EnvironmentSessionId;
    readonly environmentId: EnvironmentId;
    readonly environmentRevision: Revision;
    readonly generation: number;
    readonly epoch: number;
    readonly state: EnvironmentSessionState;
    readonly restoreFrom: EnvironmentSnapshotId | undefined;
    readonly recordRevision: Revision;
    static get codec(): RecordCodec<EnvironmentSession>;
    constructor(id: EnvironmentSessionId, environmentId: EnvironmentId, environmentRevision: Revision, generation: number, epoch: number, state: EnvironmentSessionState, restoreFrom: EnvironmentSnapshotId | undefined, recordRevision: Revision);
    static encode(session: EnvironmentSession): Uint8Array;
    static decode(bytes: Uint8Array): EnvironmentSession;
    get capability(): EnvironmentSessionCapability;
    beginOpen(): EnvironmentSession;
    opened(): EnvironmentSession;
    failOpen(): EnvironmentSession;
    lost(): EnvironmentSession;
    beginClose(): EnvironmentSession;
    closed(): EnvironmentSession;
    assertUsable(): void;
    private transition;
}
