import type { FacetManifest } from "../manifest.js";
import { type StandardProfileManifestInit } from "../profile-runtime/index.js";
export declare const TASK_ISOLATION: readonly ["provider", "bundled"];
export declare function createTaskManifest(init: StandardProfileManifestInit): FacetManifest;
