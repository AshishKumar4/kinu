import type { FacetManifest } from "../manifest.js";
import { type StandardProfileManifestInit } from "../profile-runtime/index.js";
export declare const DEVICE_ISOLATION: readonly ["provider"];
export declare const DEVICE_ENVIRONMENT_BINDING = "environment";
export declare function createDeviceManifest(init: StandardProfileManifestInit): FacetManifest;
