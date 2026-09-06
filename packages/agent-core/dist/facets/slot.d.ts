import { JsonSchema, type RecordCodec } from "../core/index.js";
import { ContributionAttribution } from "./attribution.js";
import type { FacetData } from "./data.js";
import { SlotName } from "./id.js";
export declare class SlotAuthorityPolicy {
    readonly contribute: readonly string[];
    readonly visibility: readonly string[];
    constructor(contribute: readonly string[], visibility: readonly string[]);
    static fromData(payload: FacetData): SlotAuthorityPolicy;
    static encode(policy: SlotAuthorityPolicy): Uint8Array;
    static decode(bytes: Uint8Array): SlotAuthorityPolicy;
    toData(): FacetData;
}
export declare class SlotDeclaration {
    readonly name: SlotName;
    readonly entrySchema: JsonSchema;
    readonly authority: SlotAuthorityPolicy;
    constructor(name: SlotName, entrySchema: JsonSchema, authority: SlotAuthorityPolicy);
    static fromData(payload: FacetData): SlotDeclaration;
    static encode(slot: SlotDeclaration): Uint8Array;
    static decode(bytes: Uint8Array): SlotDeclaration;
    toData(): FacetData;
}
/**
 * A Slot declaration as a Scope holds it: the manifest's declaration plus the §4.2
 * attribution of the Facet whose `slots` contribution materialized it. The manifest half
 * is authored before a release exists, so the pin lives here rather than on
 * `SlotDeclaration`, and an installed Slot the host cannot attribute cannot be built.
 */
export declare class InstalledSlot {
    readonly declaration: SlotDeclaration;
    readonly attribution: ContributionAttribution;
    constructor(declaration: SlotDeclaration, attribution: ContributionAttribution);
    static fromData(payload: FacetData): InstalledSlot;
    /**
     * The record's own codec, so a reader that must declare the kinds it can decode names
     * this one from the record rather than restating its version (§8.3).
     */
    static get codec(): RecordCodec<InstalledSlot>;
    static encode(slot: InstalledSlot): Uint8Array;
    static decode(bytes: Uint8Array): InstalledSlot;
    toData(): FacetData;
}
