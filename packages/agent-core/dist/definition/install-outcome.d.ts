import { Digest, RecordCodec, type JsonValue } from "../core/index.js";
import { ContributionAttribution, FacetPackageId } from "../facets/index.js";
import { FacetInstallFailureId } from "./id.js";
import { ManagedOrigin } from "./origin.js";
/**
 * SPEC §4.1: where an activation stopped. `start` means the Facet's own `start` hook did
 * not complete, and nothing was materialized, because a contribution's records are written
 * only after every start succeeds. `materialization` means start completed and the
 * record-write transaction failed.
 *
 * The distinction is a per-case method rather than a caller-side branch on a label,
 * because exactly one thing turns on it: only a materialization-phase failure can have
 * left attributed records the §4.1 withdrawal set must retire. The two cases are frozen
 * singletons and equality is identity, so nothing can mint a third phase or hold two
 * unequal copies of one meaning.
 */
export declare abstract class FacetInstallPhase {
    static get start(): FacetInstallPhase;
    static get materialization(): FacetInstallPhase;
    static fromData(value: JsonValue | undefined): FacetInstallPhase;
    /** The wire label this phase serializes to. */
    abstract readonly label: "start" | "materialization";
    /** Could this failure have left records a withdrawal set must retire? */
    abstract get materializedRecords(): boolean;
    toData(): JsonValue;
    equals(other: FacetInstallPhase): boolean;
}
export interface FacetInstallFailureInit {
    readonly attribution: ContributionAttribution;
    readonly packageFacet: FacetPackageId;
    readonly manifestDigest: Digest;
    readonly materialization: ManagedOrigin;
    readonly phase: FacetInstallPhase;
    readonly reason: string;
    readonly id?: FacetInstallFailureId;
}
/**
 * SPEC §4.1: the typed failed install a host records instead of a live Facet. It is
 * durable definition-plane evidence, not a diagnostic: a failed Facet is inactive,
 * obstructs nothing, and is not retried against the same unchanged Scope, and this record
 * is what makes that last clause answerable after the process that failed is gone.
 *
 * `materialization` is the exact `ManagedOrigin` the installation authenticated under, so
 * the Scope is named by Tenant, deployment, attestation, Blueprint, PackageLock, config
 * and generation. A later generation is a different origin, which is why a retry under it
 * is admitted rather than refused by an older failure.
 */
export declare class FacetInstallFailure {
    static get codec(): RecordCodec<FacetInstallFailure>;
    readonly id: FacetInstallFailureId;
    readonly attribution: ContributionAttribution;
    /** The Facet package whose activation failed. */
    readonly packageFacet: FacetPackageId;
    readonly manifestDigest: Digest;
    readonly materialization: ManagedOrigin;
    readonly phase: FacetInstallPhase;
    readonly reason: string;
    constructor(init: FacetInstallFailureInit);
    static encode(failure: FacetInstallFailure): Uint8Array;
    static decode(bytes: Uint8Array): FacetInstallFailure;
    static fromData(payload: JsonValue): FacetInstallFailure;
    /**
     * SPEC §4.1: does this failure refuse a retry of the same contribution against the same
     * unchanged Scope? Both halves are exact — the contributing FacetRef with its source
     * PackagePin, and the complete managed origin — so nothing about a changed Scope reads
     * as the one that already failed.
     */
    refuses(attribution: ContributionAttribution, materialization: ManagedOrigin): boolean;
    toData(): JsonValue;
}
