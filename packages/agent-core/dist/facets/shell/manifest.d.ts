import type { FacetManifest } from "../manifest.js";
import { type StandardProfileManifestInit } from "../profile-runtime/index.js";
export declare const SHELL_ISOLATION: readonly ["provider", "bundled"];
export declare const SHELL_REQUIRED_BINDING = "env.fs";
export declare function createShellManifest(init: StandardProfileManifestInit): FacetManifest;
