import type { FacetManifest } from "../manifest.js";
import { type StandardProfileManifestInit } from "../profile-runtime/index.js";
export declare const SELF_ISOLATION: readonly ["bundled"];
export declare function createSelfManifest(init: StandardProfileManifestInit): FacetManifest;
