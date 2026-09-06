import type { GuestTrustId, MembershipId, PrincipalId, ProjectId, RoleName, ShareOfferId, TeamId, TenantId, WorkspaceId } from "./id.js";
import { GuestTrust } from "./guest-trust.js";
import { Membership } from "./member.js";
import { Principal } from "./principal.js";
import { Project } from "./project.js";
import { Role } from "./role.js";
import { ShareOffer } from "./share-offer.js";
import { Team } from "./team.js";
import { Tenant } from "./tenant.js";
import { Workspace } from "./workspace.js";
export type IdentityRecordKind = "membership" | "guestTrust" | "principal" | "project" | "role" | "shareOffer" | "team" | "tenant" | "workspace";
export interface StoredIdentityRecord {
    readonly kind: IdentityRecordKind;
    readonly id: string;
    readonly bytes: Uint8Array;
}
export interface MemoryIdentitySnapshot {
    readonly version: 1;
    readonly records: readonly StoredIdentityRecord[];
}
export declare abstract class IdentityRepository {
    abstract loadPrincipal(id: PrincipalId): Principal | undefined;
    abstract loadTenant(id: TenantId): Tenant | undefined;
    abstract loadTeam(id: TeamId): Team | undefined;
    abstract loadProject(id: ProjectId): Project | undefined;
    abstract loadWorkspace(id: WorkspaceId): Workspace | undefined;
    abstract loadGuestTrust(id: GuestTrustId): GuestTrust | undefined;
    abstract loadRole(name: RoleName): Role | undefined;
    abstract loadMembership(id: MembershipId): Membership | undefined;
    abstract loadShareOffer(id: ShareOfferId): ShareOffer | undefined;
}
export declare class MemoryIdentityRepository extends IdentityRepository {
    #private;
    constructor(snapshot?: MemoryIdentitySnapshot);
    loadPrincipal(id: PrincipalId): Principal | undefined;
    loadTenant(id: TenantId): Tenant | undefined;
    loadTeam(id: TeamId): Team | undefined;
    loadProject(id: ProjectId): Project | undefined;
    loadWorkspace(id: WorkspaceId): Workspace | undefined;
    loadGuestTrust(id: GuestTrustId): GuestTrust | undefined;
    loadRole(name: RoleName): Role | undefined;
    loadMembership(id: MembershipId): Membership | undefined;
    loadShareOffer(id: ShareOfferId): ShareOffer | undefined;
    snapshot(): MemoryIdentitySnapshot;
    private load;
}
