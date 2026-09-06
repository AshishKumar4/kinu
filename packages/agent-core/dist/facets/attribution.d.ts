import { PackagePin } from "../definition-references/index.js";
import type { FacetData, FacetDataMap } from "./data.js";
import { FacetRef } from "./id.js";
/** The two declared fields an attributed record absorbs into its own payload. */
export type ContributionAttributionFields = {
    readonly contributor: FacetData;
    readonly package: FacetData;
};
/**
 * SPEC §4.2 (C13-FACET-CONTRIBUTION-ATTRIBUTION): the pair every record a contribution
 * materializes into carries — the exact Facet that contributed it and the release the
 * contribution was read from. It is one value object rather than two loose fields so that
 * every attributed record spells the pair the same way on the wire and the withdrawal
 * query of §4.1 reads one shape across record kinds.
 */
export declare class ContributionAttribution {
    /** The field names an attributed record's own declared fields absorb. */
    static readonly fields: readonly string[];
    readonly contributor: FacetRef;
    readonly package: PackagePin;
    constructor(contributor: FacetRef, pin: PackagePin);
    static decodeFields(object: FacetDataMap, subject: string): ContributionAttribution;
    equals(other: ContributionAttribution): boolean;
    encodeFields(): ContributionAttributionFields;
}
