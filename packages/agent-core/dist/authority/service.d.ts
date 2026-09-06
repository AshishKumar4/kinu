import { ActorId } from "../actors/index.js";
import { Revision } from "../core/index.js";
import type { ContributionAttribution } from "../facets/index.js";
import { Membership, MembershipId, GuestTrust, GuestTrustId, GuestVerification, BUILT_IN_ROLES, Principal, PrincipalId, Project, ProjectId, Role, RoleName, ShareOffer, ShareOfferId, SubjectRef, Team, TeamId, Tenant, TenantId, WorkspaceId, Workspace, type GuestTrustVerifier, type MembershipState, type ShareOfferRedemptionOutcome, type ShareOfferRedemptionRequest, type TenantKind } from "../identity/index.js";
import { ScopeEpoch } from "./epoch.js";
import { Binding } from "./binding.js";
import { Grant } from "./grant.js";
import { GrantId } from "./id.js";
export interface TenantControlBootstrapAnchor {
    readonly actorId: ActorId;
    readonly tenantId: TenantId;
    readonly principalId: PrincipalId;
    readonly trustAnchor: Uint8Array;
    readonly tenantKind?: TenantKind;
}
export interface TenantControlBootstrapPlan {
    readonly tenant: Tenant;
    readonly owner: Principal;
    readonly ownerMembership: Membership;
    readonly roles: typeof BUILT_IN_ROLES;
    readonly grants: readonly Grant[];
    readonly epochs: readonly ScopeEpoch[];
}
export declare function createTenantControlBootstrapPlan(anchor: TenantControlBootstrapAnchor, expectedRevision: Revision): TenantControlBootstrapPlan;
/** Everything a Tenant's authority records can be read through, and nothing more. */
export interface AuthorityReadStore {
    readonly tenantId: TenantId;
    principal(id: PrincipalId): Principal | undefined;
    team(id: TeamId): Team | undefined;
    teams(): readonly Team[];
    project(id: ProjectId): Project | undefined;
    projects(): readonly Project[];
    workspace(id: WorkspaceId): Workspace | undefined;
    workspaces(): readonly Workspace[];
    guestTrust(id: GuestTrustId): GuestTrust | undefined;
    guestTrusts(): readonly GuestTrust[];
    role(name: RoleName): Role | undefined;
    membership(id: MembershipId): Membership | undefined;
    memberships(): readonly Membership[];
    grant(id: GrantId): Grant | undefined;
    grants(): readonly Grant[];
    binding(key: string): Binding | undefined;
    bindings(): readonly Binding[];
    shareOffer(id: ShareOfferId): ShareOffer | undefined;
    shareOffers(): readonly ShareOffer[];
    epoch(scope: ScopeEpoch["scope"]): ScopeEpoch;
    epochs(): readonly ScopeEpoch[];
}
export interface AuthorityMutationStore extends AuthorityReadStore {
    transaction<Result>(operation: (store: AuthorityMutationStore) => Result): Result;
    putPrincipal(principal: Principal): void;
    putTeam(team: Team): void;
    putProject(project: Project): void;
    putWorkspace(workspace: Workspace): void;
    putGuestTrust(trust: GuestTrust): void;
    putRole(role: Role): void;
    putMembership(membership: Membership): void;
    putGrant(grant: Grant): void;
    putBinding(binding: Binding): void;
    putShareOffer(offer: ShareOffer): void;
    putEpoch(epoch: ScopeEpoch): void;
}
export interface MembershipChangeIntent {
    readonly role: RoleName;
    readonly state: Exclude<MembershipState, "revoked">;
}
/**
 * SPEC §4.1: what the authority Actor retired for one exact contribution, and the Scope
 * epochs that advanced with it in the same transaction. The Bindings are the records as
 * retired, so a caller reports the state a later resolution attempt will observe rather
 * than the state it asked for.
 */
export interface FacetAuthorityRetirement {
    readonly attribution: ContributionAttribution;
    readonly bindings: readonly Binding[];
    readonly grants: readonly GrantId[];
    readonly epochs: readonly ScopeEpoch[];
}
/** @internal Couples all post-bootstrap resolver-input writes in one Tenant transaction. */
export declare class AuthorityMutationService {
    #private;
    private readonly store;
    constructor(store: AuthorityMutationStore);
    createPrincipal(principal: Principal): Principal;
    disablePrincipal(id: PrincipalId): Principal;
    createTeam(team: Team): Team;
    changeTeam(id: TeamId, name: string, principals: readonly PrincipalId[]): Team;
    createWorkspace(workspace: Workspace): Workspace;
    createProject(project: Project): Project;
    renameProject(id: ProjectId, name: string): Project;
    createGuestTrust(trust: GuestTrust): GuestTrust;
    rotateGuestTrust(id: GuestTrustId, verifier: GuestTrustVerifier): GuestTrust;
    revokeGuestTrust(id: GuestTrustId): GuestTrust;
    createRole(role: Role): Role;
    changeRole(role: Role, now: Date): Role;
    assignMembership(membership: Membership): Membership;
    assignGuestMembership(membership: Membership, verification: GuestVerification, now: Date): Membership;
    changeMembership(id: MembershipId, intent: MembershipChangeIntent, now: Date): Membership;
    revokeMembership(id: MembershipId): Membership;
    createGrant(grant: Grant): Grant;
    revokeGrant(id: GrantId): Grant;
    createBinding(binding: Binding): Binding;
    replaceBinding(key: string, grantId: GrantId, facet: Binding["facet"], credentialCustody?: Binding["credentialCustody"]): Binding;
    deactivateBinding(key: string): Binding;
    /**
     * SPEC §4.1 (C13-FACET-WITHDRAWAL-EXACT): the authority plane's half of a Facet
     * withdrawal, keyed on the same `ContributionAttribution` pair the Workspace Actor
     * retires its own records under. Every Binding naming the withdrawing `FacetRef` goes
     * inactive, every live Grant whose capability names only that Facet's Operations is
     * revoked with its delegated closure, and every Scope epoch those writes affect advances
     * in this same transaction — which is what leaves a retired Binding and a moved path
     * epoch for the next resolution attempt to observe (§3.4, §8.4).
     *
     * This is the authority Actor's own transaction and nothing more: the Workspace records
     * of the same contribution are retired by the Workspace Actor in its own, because there
     * is no cross-Actor transaction anywhere (§8.1, §10.1). A withdrawal that names a Facet
     * this Tenant granted nothing retires nothing and moves no epoch.
     */
    retireFacetContribution(attribution: ContributionAttribution): FacetAuthorityRetirement;
    /**
     * Issuing an offer is an `administer`-impact act at the offer's Scope, and the
     * Membership a redemption mints is bounded by what the issuer could have assigned
     * directly (§3.3). Nothing is materialized: an offer confers no Grant and resolves no
     * Binding, so no Scope epoch moves.
     */
    issueShareOffer(offer: ShareOffer, issuer: SubjectRef): ShareOffer;
    /**
     * Revocation stops every not-yet-recorded redemption and never retracts a Membership a
     * recorded redemption already minted: only the offer record is written. An offer is not
     * a resolver input, so nothing here advances a Scope epoch — the Memberships it already
     * minted are revoked as Memberships, which is what advances their path epochs.
     */
    revokeShareOffer(id: ShareOfferId): ShareOffer;
    /**
     * One transaction linearizes a redemption against the Grant plane and the path epochs:
     * the minted Membership, the redemption recorded on the offer, the reconciled Role
     * Grants, and every affected Scope epoch commit together or not at all. A replay writes
     * nothing, because a duplicate delivery of an already-committed redemption mints no
     * second Membership and consumes no second unit of the bound.
     */
    redeemShareOffer(id: ShareOfferId, request: ShareOfferRedemptionRequest): ShareOfferRedemptionOutcome;
    private reconcile;
    private revokeGuestMemberships;
    /** The advanced epochs, so a caller that must report its own epoch move can read it. */
    private bump;
}
