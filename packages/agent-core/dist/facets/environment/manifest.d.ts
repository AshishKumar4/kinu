import type { FacetManifest } from "../manifest.js";
import { type StandardProfileManifestInit } from "../profile-runtime/index.js";
export declare const ENVIRONMENT_ISOLATION: readonly ["provider"];
export declare const ENVIRONMENT_PROVIDER_BINDING = "environment.provider";
export declare function createEnvironmentManifest(init: StandardProfileManifestInit): FacetManifest;
