import type { FacetManifest } from "../manifest.js";
import { type StandardProfileManifestInit } from "../profile-runtime/index.js";
export declare const FILESYSTEM_ISOLATION: readonly ["provider", "bundled"];
export declare function createFilesystemManifest(init: StandardProfileManifestInit): FacetManifest;
