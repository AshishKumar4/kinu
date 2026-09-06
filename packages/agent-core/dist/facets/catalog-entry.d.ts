import { ContributionAttribution } from "./attribution.js";
import { Command } from "./command.js";
import { OperationDescriptor } from "./contribution.js";
import type { FacetData } from "./data.js";
import { DataRecordCodec } from "./data.js";
import { EventDeclaration } from "./event.js";
import { InterceptorDeclaration } from "./interceptor.js";
import { CatalogEntryId, FacetRef } from "./id.js";
/**
 * The §4.2 contribution kinds whose materialization is a catalog entry. An `operations`
 * entry contributes its `OperationDescriptor`, a `commands` entry the `Command` that
 * compiles to a catalog entry plus a derived Subscription (§4.3), an `events` entry the
 * `EventDeclaration` naming an accepted Event kind and its visibility, and an
 * `interceptors` entry the `InterceptorDeclaration` that is one position in the §4.4
 * pipeline. The last two reach no primitive of their own and target no Slot declaration,
 * so the catalog entry is what carries their attribution into the §4.1 withdrawal set.
 */
export type CatalogKind = "command" | "event" | "interceptor" | "operation";
export type CatalogDeclaration = Command | EventDeclaration | InterceptorDeclaration | OperationDescriptor;
/**
 * SPEC §4.2: the position one catalog entry occupies — the declaring Facet, or no Facet
 * for a host's direct declaration, together with the declared kind and name. It is
 * deliberately a different shape from `CatalogEntryId`, because the two answer different
 * questions. The id digests every declared field including the source pin, so it answers
 * whether two materializations are the same record; the origin names the position a
 * changed contribution supersedes. Collapsing them makes a contribution re-read from a
 * later release indistinguishable from an illegal rewrite of the record it replaces.
 */
export declare class CatalogOrigin {
    readonly kind: CatalogKind;
    readonly name: string;
    readonly owner: FacetRef | undefined;
    /** Lookup key for the at-most-one-owner-per-kind-per-name index. */
    readonly key: string;
    constructor(kind: CatalogKind, name: string, owner: FacetRef | undefined);
    equals(other: CatalogOrigin): boolean;
    toData(): FacetData;
}
/**
 * A catalog entry as a Scope holds it: SPEC §4.1 materializes an `operations` or
 * `commands` contribution as one, and §4.2 requires every such record to carry the exact
 * `FacetRef` of the contributing Facet and the `PackagePin` of the release the
 * contribution was read from. A host also offers operations imperatively through the same
 * paths (§4.2), so the attribution is what separates a contribution-materialized entry
 * from a direct declaration: a direct declaration carries none and may never claim one,
 * while a contribution-materialized entry carries exactly the authenticated pair and is
 * invalid without it. That split is what makes withdrawal exact — the withdrawal set is a
 * query over these fields alone, so it never reaches a host-direct record or another
 * Facet's entry.
 */
export declare class CatalogEntry {
    readonly kind: CatalogKind;
    readonly name: string;
    readonly declaration: CatalogDeclaration;
    readonly attribution: ContributionAttribution | undefined;
    static get codec(): DataRecordCodec<CatalogEntry>;
    readonly origin: CatalogOrigin;
    readonly id: CatalogEntryId;
    constructor(kind: CatalogKind, name: string, declaration: CatalogDeclaration, attribution: ContributionAttribution | undefined);
    /**
     * A wire payload names its attribution fields only when one exists. Absence is the
     * encoding of a direct declaration, so a lone contributor or pin is malformed rather
     * than an unattributed record.
     */
    static fromData(payload: FacetData): CatalogEntry;
    static encode(entry: CatalogEntry): Uint8Array;
    static decode(bytes: Uint8Array): CatalogEntry;
    toData(): FacetData;
    private requireId;
}
