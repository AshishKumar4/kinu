import { ContentRef, Digest, RecordCodec, Revision, type JsonObject, type JsonValue } from "../core/index.js";
import { CodecRecord } from "./record-data.js";
import { AgentId, AgentPolicyId, AgentProfileId, ModelPolicyId } from "./id.js";
import { EnvironmentId } from "../environments/index.js";
interface RevisionRecordFields<Id> {
    readonly id: Id;
    readonly revision: Revision;
    readonly content: ContentRef;
    readonly digest: Digest;
}
declare abstract class RevisionRecord<Id> extends CodecRecord {
    readonly id: Id;
    readonly revision: Revision;
    readonly content: ContentRef;
    readonly digest: Digest;
    protected constructor(fields: RevisionRecordFields<Id>);
    protected baseData(id: string): JsonObject;
}
export interface AgentRevisionRecordInit extends RevisionRecordFields<AgentId> {
    readonly profile: AgentProfileId;
    readonly policy: AgentPolicyId;
    readonly model: ModelPolicyId;
    readonly environment: EnvironmentId;
}
export declare class AgentRevisionRecord extends RevisionRecord<AgentId> {
    static get codec(): RecordCodec<AgentRevisionRecord>;
    readonly profile: AgentProfileId;
    readonly policy: AgentPolicyId;
    readonly model: ModelPolicyId;
    readonly environment: EnvironmentId;
    constructor(init: AgentRevisionRecordInit);
    toData(): JsonValue;
    static fromData(value: JsonValue): AgentRevisionRecord;
}
export declare class AgentPolicyRevisionRecord extends RevisionRecord<AgentPolicyId> {
    static get codec(): RecordCodec<AgentPolicyRevisionRecord>;
    constructor(init: RevisionRecordFields<AgentPolicyId>);
    toData(): JsonValue;
    static fromData(value: JsonValue): AgentPolicyRevisionRecord;
}
export declare class ModelPolicyRevisionRecord extends RevisionRecord<ModelPolicyId> {
    static get codec(): RecordCodec<ModelPolicyRevisionRecord>;
    constructor(init: RevisionRecordFields<ModelPolicyId>);
    toData(): JsonValue;
    static fromData(value: JsonValue): ModelPolicyRevisionRecord;
}
export declare const AgentRevisionRecordCodec: RecordCodec<AgentRevisionRecord>;
export declare const AgentPolicyRevisionRecordCodec: RecordCodec<AgentPolicyRevisionRecord>;
export declare const ModelPolicyRevisionRecordCodec: RecordCodec<ModelPolicyRevisionRecord>;
export declare abstract class RunSourceRevisionPort<Transaction, Snapshot> {
    abstract verify(transaction: Transaction, snapshot: Snapshot): boolean;
    abstract verifyPackageClosure(transaction: Transaction, snapshot: Snapshot): boolean;
}
export {};
