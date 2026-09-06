import type { FacetManifest } from "../manifest.js";
import { type StandardProfileManifestInit } from "../profile-runtime/index.js";
export declare const WEB_ISOLATION: readonly ["provider"];
export declare function createWebManifest(init: StandardProfileManifestInit): FacetManifest;
