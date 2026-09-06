import { RecordCodec } from "../core/index.js";
import { ContributionAttribution } from "./attribution.js";
import type { FacetData } from "./data.js";
import { FacetRef, PromptSectionId } from "./id.js";
/**
 * SPEC §4.2: the position one contributed prompt section occupies — the exact pair a
 * contribution holds at most one section for. It mirrors `SlotContributionOrigin`: the id
 * digests every declared field and answers whether two materializations are the same
 * record, the origin names the slot a changed contribution supersedes. Collapsing them
 * makes a contribution re-read from a later release indistinguishable from an illegal
 * rewrite of the record it replaces.
 */
export declare class PromptSectionContributionOrigin {
    readonly contributor: FacetRef;
    readonly position: number;
    /** Lookup key for the at-most-one-section-per-contributor-per-position index. */
    readonly key: string;
    constructor(contributor: FacetRef, position: number);
    equals(other: PromptSectionContributionOrigin): boolean;
}
/**
 * SPEC §4.2 (C13-FACET-CONTRIBUTION-ATTRIBUTION): one prompt-assembly section as the owning
 * Workspace holds it, carrying the exact `FacetRef` whose `prompt` contribution materialized
 * it and the `PackagePin` of the release it was read from. The declaration half is authored
 * in a manifest before any release exists, so the pin lives here rather than on `Prompt` —
 * the same split `SurfaceRegistration` makes for Surfaces — and a section the host cannot
 * attribute cannot be built. That is what lets a host answer from records alone which Facet
 * is responsible for a prompt section, what puts the section in that Facet's §4.1 withdrawal
 * set, and what keeps unrelated sections' order stable while one contributor's set retires.
 */
export declare class PromptSection {
    readonly title: string;
    readonly body: string;
    readonly priority: number;
    readonly attribution: ContributionAttribution;
    readonly position: number;
    static get codec(): RecordCodec<PromptSection>;
    /**
     * The order a host assembles stored sections in: declared priority first, then the
     * declared text, then the origin. Every key is a declared field or the origin, so two
     * stores of the same records list them in the same order without consulting anything
     * outside this record.
     */
    static compare(left: PromptSection, right: PromptSection): number;
    readonly id: PromptSectionId;
    /**
     * The §4.2 position this section occupies. It is derived from declared fields rather
     * than stored, so it adds nothing to the record's shape and cannot drift from it.
     */
    readonly origin: PromptSectionContributionOrigin;
    constructor(title: string, body: string, priority: number, attribution: ContributionAttribution, position: number, id?: PromptSectionId);
    static encode(section: PromptSection): Uint8Array;
    static decode(bytes: Uint8Array): PromptSection;
    static fromData(payload: FacetData): PromptSection;
    toData(): FacetData;
}
