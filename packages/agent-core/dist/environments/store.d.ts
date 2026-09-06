import { Revision } from "../core/index.js";
import { type ContentCustodyPort } from "../content/index.js";
import { Environment, EnvironmentRevisionRecord } from "./environment.js";
import { PortExposure } from "./exposure.js";
import { EnvironmentId, EnvironmentSessionId, EnvironmentSnapshotId, PortExposureId } from "./id.js";
import { EnvironmentSession } from "./session.js";
import { EnvironmentSnapshot } from "./snapshot.js";
export type EnvironmentStoredRecordKind = "head" | "revision" | "session" | "snapshot" | "exposure";
export interface EnvironmentStoredRow {
    readonly kind: EnvironmentStoredRecordKind;
    readonly key: string;
    readonly recordRevision: number;
    readonly projection: readonly string[];
    readonly bytes: Uint8Array;
}
export interface EnvironmentStoreImage {
    readonly rows: readonly EnvironmentStoredRow[];
}
/**
 * The custody seam the Environment Actor's store registers through (§8.4). Like the Slate
 * plane, an Environment write is one call rather than a transaction the content plane can
 * join, so the store is the token the custody receives and registration precedes the row.
 */
export type EnvironmentContentCustody = ContentCustodyPort<EnvironmentStore>;
export declare abstract class EnvironmentStore {
    abstract getEnvironment(id: EnvironmentId): Environment | undefined;
    abstract getRevision(environmentId: EnvironmentId, revision: Revision): EnvironmentRevisionRecord | undefined;
    abstract compareAndSetEnvironment(expected: Revision | undefined, revision: EnvironmentRevisionRecord, environment: Environment): boolean;
    abstract getSession(id: EnvironmentSessionId): EnvironmentSession | undefined;
    abstract compareAndSetSession(expected: Revision | undefined, session: EnvironmentSession): boolean;
    abstract getSnapshot(id: EnvironmentSnapshotId): EnvironmentSnapshot | undefined;
    abstract compareAndSetSnapshot(expected: Revision | undefined, snapshot: EnvironmentSnapshot): boolean;
    abstract getExposure(id: PortExposureId): PortExposure | undefined;
    abstract listExposures(sessionId: EnvironmentSessionId): readonly PortExposure[];
    abstract compareAndSetExposure(expected: Revision | undefined, exposure: PortExposure): boolean;
}
export declare class MemoryEnvironmentStore extends EnvironmentStore {
    #private;
    constructor(custody: EnvironmentContentCustody, image?: EnvironmentStoreImage);
    /**
     * Registers a record's ContentRefs before its row lands, releasing whatever the stored
     * revision named and this one does not. An Environment revision is immutable, so only a
     * snapshot that captures new state ever releases.
     */
    private register;
    exportImage(): EnvironmentStoreImage;
    getEnvironment(id: EnvironmentId): Environment | undefined;
    getRevision(environmentId: EnvironmentId, revision: Revision): EnvironmentRevisionRecord | undefined;
    compareAndSetEnvironment(expected: Revision | undefined, revision: EnvironmentRevisionRecord, environment: Environment): boolean;
    protected beforeEnvironmentHeadCommit(): void;
    getSession(id: EnvironmentSessionId): EnvironmentSession | undefined;
    compareAndSetSession(expected: Revision | undefined, session: EnvironmentSession): boolean;
    getSnapshot(id: EnvironmentSnapshotId): EnvironmentSnapshot | undefined;
    compareAndSetSnapshot(expected: Revision | undefined, snapshot: EnvironmentSnapshot): boolean;
    getExposure(id: PortExposureId): PortExposure | undefined;
    listExposures(sessionId: EnvironmentSessionId): readonly PortExposure[];
    compareAndSetExposure(expected: Revision | undefined, exposure: PortExposure): boolean;
    private compareAndSet;
    private validateSessionPin;
    private validateSnapshotPin;
    private validateExposurePin;
    private requirePinnedRevision;
    private validateImage;
    private validateRevisionSequence;
}
