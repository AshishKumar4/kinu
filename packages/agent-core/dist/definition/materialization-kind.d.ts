import { type JsonValue } from "../core/index.js";
import { AgentCoreError } from "../errors.js";
/**
 * Named so the stored-record decode path can tell "this build does not know this
 * materialization kind" (forward compatible; the store may be reset and rebuilt) from
 * "these bytes are corrupt". Both surface as codec.invalid, so a substring test on the
 * message was the only thing carrying the distinction -- and RecordCodec.decode wraps a
 * TypeError into a new message, so that test survived only by textual coincidence. An
 * AgentCoreError subclass is rethrown by that wrapper unchanged.
 */
export declare class UnknownMaterializationKindError extends AgentCoreError {
    constructor(recordKind: string);
}
/**
 * The synthetic contributor the planner projects Blueprint-declared slots under
 * (SPEC §9.3). A Blueprint declares slots from its own document (§9.2), not from a
 * Package release, so slot-entry records under this contributor carry no source pin,
 * and no Facet may claim the name: declaration validation refuses a manifest whose id
 * would collide with it.
 */
export declare const BLUEPRINT_CONTRIBUTOR = "blueprint";
export declare function supportedMaterializationKinds(): readonly string[];
export declare function requireMaterializationKind(recordKind: string): void;
export declare function validateMaterializationKind(recordKind: string, desired: JsonValue): void;
export declare function canonicalMaterializationDesired(recordKind: string, desired: JsonValue): JsonValue;
