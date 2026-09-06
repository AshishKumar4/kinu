import { JsonSchema } from "../core/index.js";
import { ContributionAttribution } from "./attribution.js";
import type { FacetData } from "./data.js";
import { DataRecordCodec } from "./data.js";
import { FacetRef, SettingsLayerId } from "./id.js";
/**
 * SPEC §4.2: the position one settings layer occupies in the merged platform config
 * view — the contributing Facet and the declared order of its fragment among that
 * Facet's own `settings` contributions. It is deliberately a different shape from
 * `SettingsLayerId`, because the two answer different questions: the id digests every
 * declared field, so it answers whether two materializations are the same record; the
 * origin names the position a changed contribution supersedes.
 */
export declare class SettingsLayerOrigin {
    readonly contributor: FacetRef;
    readonly ordinal: number;
    /** Lookup key for the at-most-one-layer-per-contributor-per-ordinal index. */
    readonly key: string;
    constructor(contributor: FacetRef, ordinal: number);
    equals(other: SettingsLayerOrigin): boolean;
}
/**
 * SPEC §4.2: one Facet's contributed settings fragment as a Scope holds it — the declared
 * JSON-schema fragment paired with the §4.2 attribution of the release it was read from.
 * The declaration half is authored in a manifest before any release exists, so the pin
 * lives here rather than beside the fragment — the same split an InstalledSlot or a
 * SurfaceRegistration makes — and a layer the host cannot attribute cannot be built.
 * That is what lets a host answer from records alone which Facet contributed any part of
 * the merged config schema, and what puts the layer in that Facet's §4.1 withdrawal set.
 */
export declare class SettingsLayer {
    readonly attribution: ContributionAttribution;
    readonly ordinal: number;
    static get codec(): DataRecordCodec<SettingsLayer>;
    readonly schema: JsonSchema;
    readonly origin: SettingsLayerOrigin;
    /**
     * Derived from the declared fields rather than stored, so it adds nothing to the
     * record's shape and cannot drift from it.
     */
    readonly id: SettingsLayerId;
    constructor(attribution: ContributionAttribution, ordinal: number, schema: FacetData);
    static encode(layer: SettingsLayer): Uint8Array;
    static decode(bytes: Uint8Array): SettingsLayer;
    static fromData(payload: FacetData): SettingsLayer;
    toData(): FacetData;
}
