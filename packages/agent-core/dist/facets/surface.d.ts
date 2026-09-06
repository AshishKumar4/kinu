import { ContributionAttribution } from "./attribution.js";
import { SurfaceDescriptor } from "./contribution.js";
import type { FacetData } from "./data.js";
import { DataRecordCodec } from "./data.js";
/**
 * A Surface as a Scope holds it: SPEC §6.3's stable UI contribution from a Facet, paired
 * with the §4.2 attribution of the Facet whose `surfaces` contribution materialized it. The
 * declaration half is authored in a manifest before any release exists, so the pin lives
 * here rather than on `SurfaceDescriptor` — the same split `InstalledSlot` makes for Slots —
 * and a registration the host cannot attribute cannot be built. That is what lets a host
 * answer from records alone which Facet is responsible for a rendered Surface, and what puts
 * the Surface in that Facet's §4.1 withdrawal set.
 */
export declare class SurfaceRegistration {
    readonly descriptor: SurfaceDescriptor;
    readonly attribution: ContributionAttribution;
    static get codec(): DataRecordCodec<SurfaceRegistration>;
    constructor(descriptor: SurfaceDescriptor, attribution: ContributionAttribution);
    static fromData(payload: FacetData): SurfaceRegistration;
    static encode(registration: SurfaceRegistration): Uint8Array;
    static decode(bytes: Uint8Array): SurfaceRegistration;
    toData(): FacetData;
}
