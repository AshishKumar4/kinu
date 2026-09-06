import { Digest } from "../core/index.js";
import { ContributionAttribution, FacetPackageId, FacetRef, PackageInstallationRef } from "../facets/index.js";
import { ManagedOrigin } from "./origin.js";
import { PackagePin } from "./package-lock.js";
export interface AuthenticatedPackageInstallation {
    readonly package: PackagePin;
    readonly packageFacet: FacetPackageId;
    readonly facet: FacetRef;
    readonly manifestDigest: Digest;
    readonly materialization: ManagedOrigin;
}
export interface PreparedPackageContribution {
    readonly reference: PackageInstallationRef;
    readonly manifestDigest: Digest;
    readonly materialization: ManagedOrigin;
    readonly stamp: object;
}
/**
 * One-use authority to materialize a record from an authenticated package contribution.
 * It carries no public fields: only PackageInstallationProvenancePort can mint one after
 * its prepare/apply proof succeeds.
 */
declare class AuthenticatedContributionToken {
    #private;
    static consume(candidate: AuthenticatedContributionToken): ContributionAttribution | undefined;
}
export type AuthenticatedContribution = AuthenticatedContributionToken;
/**
 * Consumes the capability so one successful provenance check authorizes one materialization.
 * A structurally forged token has no WeakMap entry and is not authority.
 */
export declare function consumeAuthenticatedContribution(candidate: AuthenticatedContribution): ContributionAttribution | undefined;
export declare abstract class PackageInstallationProvenancePort<State, Context> {
    #private;
    protected abstract authenticatedInstallation(state: State, context: Context): AuthenticatedPackageInstallation | undefined;
    reference(state: State, context: Context): PackageInstallationRef | undefined;
    prepareContribution(state: State, context: Context): PreparedPackageContribution | undefined;
    discardPreparedContribution(stamp: PreparedPackageContribution["stamp"]): void;
    resolveContributionForApply(state: State, context: Context, stamp: PreparedPackageContribution["stamp"]): PackageInstallationRef | undefined;
    /**
     * Binds an opaque materialization capability to this synchronous prepare/apply span.
     * The callback must consume it before returning; finally revokes an unconsumed token,
     * so it cannot cross an await, restart, or RPC boundary as durable authority.
     */
    withAuthenticatedContribution<Result>(state: State, context: Context, stamp: PreparedPackageContribution["stamp"], materialize: (contribution: AuthenticatedContribution) => Result): Result | undefined;
}
export {};
