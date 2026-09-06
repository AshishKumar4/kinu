import { JsonSchema, type CompatRange, type SemVer } from "../../core/index.js";
import { Contributions } from "../contribution.js";
import type { FacetPackageId } from "../id.js";
import type { BindingRequirement, IsolationMode } from "../manifest.js";
import { FacetManifest } from "../manifest.js";
export interface StandardProfileManifestInit {
    readonly id: FacetPackageId;
    readonly version: SemVer;
    readonly compat: CompatRange;
    readonly bindings: readonly BindingRequirement[];
    readonly configSchema?: JsonSchema;
}
export interface StandardProfileManifestDefinition {
    readonly isolation: readonly [IsolationMode, ...IsolationMode[]];
    readonly contributions: Contributions;
    readonly requiredBindings?: readonly string[];
    readonly configConstraint?: JsonSchema;
}
export declare function createStandardProfileManifest(init: StandardProfileManifestInit, definition: StandardProfileManifestDefinition): FacetManifest;
