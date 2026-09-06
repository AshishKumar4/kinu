import { JsonSchema } from "../../core/index.js";
import type { FacetManifest } from "../manifest.js";
import { type StandardProfileManifestInit } from "../profile-runtime/index.js";
export declare const SLATE_ENVIRONMENT_BINDING = "environment";
export declare const SLATE_CONFIG_CONSTRAINT: JsonSchema;
export declare function createSlateManifest(init: StandardProfileManifestInit): FacetManifest;
