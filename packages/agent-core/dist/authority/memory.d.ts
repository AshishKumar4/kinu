import { ActorId } from "../actors/index.js";
import { Revision } from "../core/index.js";
import { Membership, MembershipId, GuestTrust, GuestTrustId, Principal, PrincipalId, Project, ProjectId, Role, RoleName, ShareOffer, ShareOfferId, Team, TeamId, Tenant, TenantId, WorkspaceId, Workspace, type MemoryIdentitySnapshot, type TenantKind } from "../identity/index.js";
import { Binding } from "./binding.js";
import { ScopeEpoch } from "./epoch.js";
import { Grant } from "./grant.js";
import type { GrantId } from "./id.js";
import { type AuthorityMutationStore, type TenantControlBootstrapAnchor, type TenantControlBootstrapPlan } from "./service.js";
export type { TenantControlBootstrapAnchor } from "./service.js";
export interface StoredTenantControlRecord {
    readonly id: string;
    readonly bytes: Uint8Array;
}
export interface MemoryTenantControlAnchorSnapshot {
    readonly actorId: ActorId;
    readonly tenantId: TenantId;
    readonly principalId: PrincipalId;
    readonly tenantKind: TenantKind;
    readonly trustAnchor: Uint8Array;
}
export interface MemoryTenantControlMarkerSnapshot {
    readonly tenantId: TenantId;
    readonly ownerPrincipalId: PrincipalId;
    readonly revision: number;
}
export interface MemoryTenantControlSnapshot {
    readonly version: 2;
    readonly anchor: MemoryTenantControlAnchorSnapshot;
    readonly marker: MemoryTenantControlMarkerSnapshot | null;
    readonly identity: MemoryIdentitySnapshot;
    readonly grants: readonly StoredTenantControlRecord[];
    readonly bindings: readonly StoredTenantControlRecord[];
    readonly epochs: readonly StoredTenantControlRecord[];
}
export interface TenantControlBootstrapMarker {
    readonly tenantId: TenantId;
    readonly ownerPrincipalId: PrincipalId;
    readonly revision: Revision;
}
/** Actor-local reference store. It is intentionally absent from the authority package surface. */
export declare class MemoryTenantControlStore implements AuthorityMutationStore {
    #private;
    readonly tenantId: TenantId;
    private constructor();
    static create(anchor: TenantControlBootstrapAnchor): MemoryTenantControlStore;
    static restore(snapshot: MemoryTenantControlSnapshot): MemoryTenantControlStore;
    bootstrapAnchor(): TenantControlBootstrapAnchor;
    bootstrapMarker(): TenantControlBootstrapMarker | undefined;
    isBootstrapEligible(): boolean;
    bootstrap(plan: TenantControlBootstrapPlan): void;
    bootstrapTenant(anchor: TenantControlBootstrapAnchor, expectedRevision: Revision): void;
    transaction<Result>(operation: (store: AuthorityMutationStore) => Result): Result;
    snapshot(): MemoryTenantControlSnapshot;
    identitySnapshot(): MemoryIdentitySnapshot;
    tenant(id: TenantId): Tenant | undefined;
    principal(id: PrincipalId): Principal | undefined;
    team(id: TeamId): Team | undefined;
    teams(): readonly Team[];
    project(id: ProjectId): Project | undefined;
    projects(): readonly Project[];
    putProject(project: Project): void;
    workspace(id: WorkspaceId): Workspace | undefined;
    workspaces(): readonly Workspace[];
    putWorkspace(workspace: Workspace): void;
    guestTrust(id: GuestTrustId): GuestTrust | undefined;
    guestTrusts(): readonly GuestTrust[];
    putGuestTrust(trust: GuestTrust): void;
    role(name: RoleName): Role | undefined;
    roles(): readonly Role[];
    membership(id: MembershipId): Membership | undefined;
    memberships(): readonly Membership[];
    shareOffer(id: ShareOfferId): ShareOffer | undefined;
    shareOffers(): readonly ShareOffer[];
    grant(id: GrantId): Grant | undefined;
    grants(): readonly Grant[];
    binding(key: string): Binding | undefined;
    bindings(): readonly Binding[];
    epoch(scope: ScopeEpoch["scope"]): ScopeEpoch;
    epochs(): readonly ScopeEpoch[];
    putPrincipal(principal: Principal): void;
    putTeam(team: Team): void;
    putRole(role: Role): void;
    putMembership(membership: Membership): void;
    putShareOffer(offer: ShareOffer): void;
    putGrant(record: Grant): void;
    putBinding(record: Binding): void;
    putEpoch(record: ScopeEpoch): void;
    private applyBootstrap;
    private commit;
    private identityRecord;
    private identityRecords;
    private putIdentity;
    private requireWrite;
    private assertRestoredState;
    private replace;
}
