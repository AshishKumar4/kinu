import { ContributionAttribution } from "./attribution.js";
import { FacetPackageId } from "./id.js";
/**
 * The authenticated installation a materializing host reads a contribution under. It
 * carries the §4.2 attribution rather than a bare FacetRef, so a host that cannot name
 * both the contributing Facet and the release it was read from cannot build one — which
 * is what makes refusal, not unattributed materialization, the only other outcome.
 */
export declare class PackageInstallationRef {
    readonly attribution: ContributionAttribution;
    readonly packageFacet: FacetPackageId;
    constructor(attribution: ContributionAttribution, packageFacet: FacetPackageId);
}
