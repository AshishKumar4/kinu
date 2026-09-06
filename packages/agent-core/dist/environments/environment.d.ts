import { type ContentRetentionField, RecordCodec, Revision } from "../core/index.js";
import { EnvironmentId } from "./id.js";
import { ProviderDescriptor } from "./provider.js";
export declare class Environment {
    readonly id: EnvironmentId;
    readonly activeRevision: Revision;
    readonly generation: number;
    readonly recordRevision: Revision;
    static get codec(): RecordCodec<Environment>;
    constructor(id: EnvironmentId, activeRevision: Revision, generation: number, recordRevision: Revision);
    static encode(environment: Environment): Uint8Array;
    static decode(bytes: Uint8Array): Environment;
    rotate(revision: EnvironmentRevisionRecord): Environment;
}
export declare class EnvironmentRevisionRecord {
    readonly environmentId: EnvironmentId;
    readonly revision: Revision;
    readonly generation: number;
    readonly provider: ProviderDescriptor;
    static get codec(): RecordCodec<EnvironmentRevisionRecord>;
    constructor(environmentId: EnvironmentId, revision: Revision, generation: number, provider: ProviderDescriptor);
    static encode(record: EnvironmentRevisionRecord): Uint8Array;
    static decode(bytes: Uint8Array): EnvironmentRevisionRecord;
}
/**
 * The provider configuration one immutable Environment revision names (§8.4). Revisions are
 * append-only — a head that advances installs a new revision rather than rewriting one — so
 * this retention is owed on write and the superseded revision keeps holding its own bytes.
 */
export declare function environmentRevisionContentRetention(value: EnvironmentRevisionRecord): readonly ContentRetentionField[];
