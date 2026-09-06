import { JsonSchema } from "../../core/index.js";
import type { FacetManifest } from "../manifest.js";
import { type StandardProfileManifestInit } from "../profile-runtime/index.js";
export declare const MCP_ISOLATION: readonly ["provider", "bundled"];
export declare const MCP_PARENT_BINDING = "mcp.server";
export declare const MCP_CONFIG_CONSTRAINT: JsonSchema;
export declare function createMcpManifest(init: StandardProfileManifestInit): FacetManifest;
