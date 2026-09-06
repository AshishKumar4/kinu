import type { FacetManifest } from "../manifest.js";
import { type StandardProfileManifestInit } from "../profile-runtime/index.js";
export declare const MEMORY_ISOLATION: readonly ["provider", "bundled"];
export declare function createMemoryManifest(init: StandardProfileManifestInit): FacetManifest;
