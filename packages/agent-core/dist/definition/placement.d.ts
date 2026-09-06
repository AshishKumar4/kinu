import { RecordCodec, type JsonValue } from "../core/index.js";
import { AuthoredCodeBackingId, PLACEMENT_PREFERENCE, type AuthoredCodeConsumer, type IsolationMode } from "../facets/index.js";
import { AgentCoreError } from "../errors.js";
import type { PackageId } from "./id.js";
export { PLACEMENT_PREFERENCE, AuthoredCodeBackingId };
export type { AuthoredCodeConsumer };
/**
 * Which backing serves which §4.7 consumer, as `policies.placement` declares it
 * (§9.2). The mapping is partial on purpose: a consumer the Blueprint does not name
 * uses the substrate profile's declared default backing rather than an arbitrary one.
 * Backings differ operationally and never in authority, so this record is a hosting
 * choice and carries no capability.
 */
export declare class AuthoredCodeBackingPolicy {
    #private;
    constructor(backings: ReadonlyMap<AuthoredCodeConsumer, AuthoredCodeBackingId>);
    static get unmapped(): AuthoredCodeBackingPolicy;
    static fromData(payload: JsonValue | undefined): AuthoredCodeBackingPolicy;
    /**
     * The backing that serves `consumer`: the declared mapping when the Blueprint names
     * one, and otherwise the profile's declared default. There is no third outcome —
     * an unmapped consumer never reaches an arbitrary offered backing.
     */
    backingFor(consumer: AuthoredCodeConsumer, profileDefault: AuthoredCodeBackingId): AuthoredCodeBackingId;
    get isEmpty(): boolean;
    get consumers(): readonly AuthoredCodeConsumer[];
    toData(): JsonValue;
}
export type NonemptyIsolationModes = readonly [IsolationMode, ...IsolationMode[]];
export type PlacementErrorCode = "operation.invalid-input";
export declare class PlacementUnavailableError extends AgentCoreError {
    constructor(message: string);
}
export declare class PlacementPolicy {
    static get codec(): RecordCodec<PlacementPolicy>;
    readonly allowed: NonemptyIsolationModes;
    readonly trusted: readonly string[];
    readonly backings: AuthoredCodeBackingPolicy;
    constructor(allowed: readonly IsolationMode[], trusted: readonly string[], backings?: AuthoredCodeBackingPolicy);
    static all(): PlacementPolicy;
    static encode(policy: PlacementPolicy): Uint8Array;
    static decode(bytes: Uint8Array): PlacementPolicy;
    static fromData(payload: JsonValue): PlacementPolicy;
    admits(mode: IsolationMode): boolean;
    trusts(packageId: PackageId): boolean;
    trustedModes(packageId: PackageId): NonemptyIsolationModes;
    backingFor(consumer: AuthoredCodeConsumer, profileDefault: AuthoredCodeBackingId): AuthoredCodeBackingId;
    toData(): JsonValue;
}
export interface PlacementInputInit {
    readonly manifest: readonly IsolationMode[];
    readonly policy: readonly IsolationMode[];
    readonly substrate: readonly IsolationMode[];
    readonly trust: readonly IsolationMode[];
}
export declare class PlacementInput {
    readonly manifest: NonemptyIsolationModes;
    readonly policy: NonemptyIsolationModes;
    readonly substrate: NonemptyIsolationModes;
    readonly trust: NonemptyIsolationModes;
    constructor(init: PlacementInputInit);
}
export declare class PlacementSelection {
    readonly selected: IsolationMode;
    readonly manifest: NonemptyIsolationModes;
    readonly policy: NonemptyIsolationModes;
    readonly substrate: NonemptyIsolationModes;
    readonly trust: NonemptyIsolationModes;
    constructor(input: PlacementInput, selected: IsolationMode);
}
export declare function preferredPlacement(manifest: readonly IsolationMode[], policy: readonly IsolationMode[], substrate: readonly IsolationMode[], trust: readonly IsolationMode[]): IsolationMode | undefined;
export declare function selectPlacement(input: PlacementInput | PlacementInputInit): PlacementSelection;
export declare function trustPlacementModes(trustedPackage: boolean): NonemptyIsolationModes;
export declare function parseIsolationMode(value: JsonValue, subject: string): IsolationMode;
