import { RecordCodec } from "../core/index.js";
import { ContributionAttribution } from "./attribution.js";
import type { FacetData } from "./data.js";
import { FacetRef, SlotEntryId, SlotName } from "./id.js";
/**
 * SPEC §4.2: the position a contribution occupies — the exact triple a slot holds at most
 * one entry for. It is deliberately a different shape from `SlotEntryId`, because the two
 * answer different questions. The id digests every declared field, so it answers whether
 * two materializations are the same record; the origin names the position a changed
 * contribution supersedes. Collapsing them makes a contribution re-read from a later
 * release indistinguishable from an illegal rewrite of the record it replaces.
 */
export declare class SlotContributionOrigin {
    readonly slot: SlotName;
    readonly contributor: FacetRef;
    readonly ordinal: number;
    /** Lookup key for the at-most-one-entry-per-contributor-per-ordinal index. */
    readonly key: string;
    constructor(slot: SlotName, contributor: FacetRef, ordinal: number);
    equals(other: SlotContributionOrigin): boolean;
}
export declare class SlotEntry {
    readonly slot: SlotName;
    readonly attribution: ContributionAttribution;
    readonly ordinal: number;
    static get codec(): RecordCodec<SlotEntry>;
    readonly value: FacetData;
    readonly id: SlotEntryId;
    /**
     * The §4.2 position this entry occupies. It is derived from declared fields rather than
     * stored, so it adds nothing to the record's shape and cannot drift from it.
     */
    readonly origin: SlotContributionOrigin;
    constructor(slot: SlotName, attribution: ContributionAttribution, ordinal: number, value: FacetData, id?: SlotEntryId);
    static encode(entry: SlotEntry): Uint8Array;
    static decode(bytes: Uint8Array): SlotEntry;
    static fromData(payload: FacetData): SlotEntry;
    toData(): FacetData;
}
