import { type JsonValue } from "../core/index.js";
import type { JsonPatchEngine } from "../workspaces/index.js";
export declare class DetachedJsonPatchEngine implements JsonPatchEngine {
    apply(document: JsonValue, patch: readonly JsonValue[]): JsonValue;
}
