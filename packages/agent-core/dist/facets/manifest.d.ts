import { CompatRange, JsonSchema, SemVer } from "../core/index.js";
import type { FacetData } from "./data.js";
import { Contributions } from "./contribution.js";
import { BindingName, FacetPackageId } from "./id.js";
import type { IsolationMode } from "./generated/placement/AgentCore/Extract/Placement.js";
export type { IsolationMode } from "./generated/placement/AgentCore/Extract/Placement.js";
export { PlacementIntersection, admitsMode, preferredPlacement } from "./generated/placement/AgentCore/Extract/Placement.js";
export declare const PLACEMENT_PREFERENCE: readonly IsolationMode[];
export declare class BindingRequirement {
    readonly name: BindingName;
    readonly facet: FacetPackageId;
    readonly compat: CompatRange;
    constructor(name: BindingName, facet: FacetPackageId, compat: CompatRange);
    static fromData(payload: FacetData): BindingRequirement;
    static encode(requirement: BindingRequirement): Uint8Array;
    static decode(bytes: Uint8Array): BindingRequirement;
    toData(): FacetData;
}
export interface FacetManifestInit {
    readonly id: FacetPackageId;
    readonly version: SemVer;
    readonly compat: CompatRange;
    readonly isolation: readonly [IsolationMode, ...IsolationMode[]];
    readonly bindings: readonly BindingRequirement[];
    readonly configSchema?: JsonSchema | undefined;
    readonly contributions: Contributions;
}
export declare class FacetManifest {
    readonly id: FacetPackageId;
    readonly version: SemVer;
    readonly compat: CompatRange;
    readonly isolation: readonly [IsolationMode, ...IsolationMode[]];
    readonly bindings: readonly BindingRequirement[];
    readonly configSchema: JsonSchema | undefined;
    readonly contributions: Contributions;
    constructor(init: FacetManifestInit);
    static fromData(payload: FacetData): FacetManifest;
    static encode(manifest: FacetManifest): Uint8Array;
    static decode(bytes: Uint8Array): FacetManifest;
    toData(): FacetData;
}
export declare function canonicalIsolationModes(modes: readonly [IsolationMode, ...IsolationMode[]]): readonly [IsolationMode, ...IsolationMode[]];
