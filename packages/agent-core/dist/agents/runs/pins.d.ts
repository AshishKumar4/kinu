import { Digest, RecordCodec, Revision, SemVer, type JsonValue } from "../../core/index.js";
import { PackagePin } from "../../definition/index.js";
import { EnvironmentId } from "../../environments/index.js";
import { AgentId, AgentPolicyId, ModelPolicyId } from "../id.js";
import { CodecRecord } from "../record-data.js";
export declare class BlueprintPin {
    readonly name: string;
    readonly version: SemVer;
    readonly digest: Digest;
    constructor(name: string, version: SemVer, digest: Digest);
    toData(): JsonValue;
    static fromData(value: JsonValue): BlueprintPin;
}
export interface RunPinsInit {
    readonly blueprint: BlueprintPin;
    readonly packages: readonly PackagePin[];
    readonly agent: SourcePin<AgentId>;
    readonly effectivePolicy: SourcePin<AgentPolicyId>;
    readonly modelPolicy: SourcePin<ModelPolicyId>;
    readonly environment: SourcePin<EnvironmentId>;
}
export interface SourcePin<Id> {
    readonly id: Id;
    readonly revision: Revision;
    readonly digest: Digest;
}
export declare class RunPins extends CodecRecord {
    static get codec(): RecordCodec<RunPins>;
    readonly blueprint: BlueprintPin;
    readonly packages: readonly PackagePin[];
    readonly agent: SourcePin<AgentId>;
    readonly effectivePolicy: SourcePin<AgentPolicyId>;
    readonly modelPolicy: SourcePin<ModelPolicyId>;
    readonly environment: SourcePin<EnvironmentId>;
    readonly digest: Digest;
    constructor(init: RunPinsInit);
    equals(other: RunPins): boolean;
    /**
     * The dimensions in which this pin set differs from another, with the exact identities
     * that differ in each. Derived from the two records whenever it is asked for and stored
     * nowhere: a merge names both of its parents, so both pin records are already durable,
     * and recording their difference would be a second copy of what the graph holds. Empty
     * exactly when `equals` holds.
     */
    divergence(other: RunPins): readonly RunPinDivergence[];
    toData(): JsonValue;
    static fromData(value: JsonValue): RunPins;
}
export declare const RunPinsCodec: RecordCodec<RunPins>;
/** One dimension of a RunPins comparison, with the exact identities that differ in it. */
export interface RunPinDivergence {
    readonly dimension: RunPinDimension;
    /** Nonempty: the identities this dimension disagrees about. */
    readonly identities: readonly string[];
}
/**
 * The closed set of dimensions RunPins carries. A merge requires equal pins on both parents,
 * and a refusal saying only that two pin sets were unequal leaves the caller to search for the
 * disagreement the platform already found — so each case owns the comparison for its own
 * dimension and names what differs. `all` is the one place the dimensions are enumerated, so a
 * pin field nobody taught to compare is visible here rather than silently equal.
 */
export declare abstract class RunPinDimension {
    static get blueprint(): RunPinDimension;
    static get packages(): RunPinDimension;
    static get agent(): RunPinDimension;
    static get effectivePolicy(): RunPinDimension;
    static get modelPolicy(): RunPinDimension;
    static get environment(): RunPinDimension;
    /** Every dimension, in the order a refusal names them. */
    static get all(): readonly RunPinDimension[];
    abstract readonly label: string;
    /** The identities that differ in this dimension, empty when it agrees. */
    abstract divergentIdentities(left: RunPins, right: RunPins): readonly string[];
    equals(other: RunPinDimension): boolean;
}
export interface RunConfigurationSnapshotInit {
    readonly pins: RunPins;
}
export declare class RunConfigurationSnapshot extends CodecRecord {
    static get codec(): RecordCodec<RunConfigurationSnapshot>;
    readonly pins: RunPins;
    readonly id: Digest;
    constructor(init: RunConfigurationSnapshotInit);
    toData(): JsonValue;
    static fromData(value: JsonValue): RunConfigurationSnapshot;
}
export declare const RunConfigurationSnapshotCodec: RecordCodec<RunConfigurationSnapshot>;
