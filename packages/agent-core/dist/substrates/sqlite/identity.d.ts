import { Membership, MembershipId, GuestTrust, GuestTrustId, IdentityRepository, Principal, PrincipalId, Project, ProjectId, Role, RoleName, ShareOffer, ShareOfferId, Team, TeamId, Tenant, TenantId, WorkspaceId, Workspace } from "../../identity/index.js";
import { ReadableSqlite, TransactionalSqlite } from "./sqlite.js";
export declare function initializeSqliteIdentitySchema(database: TransactionalSqlite): void;
export declare class SqliteIdentityReader extends IdentityRepository {
    protected readonly readDatabase: ReadableSqlite;
    constructor(readDatabase: ReadableSqlite);
    loadPrincipal(id: PrincipalId): Principal | undefined;
    loadTenant(id: TenantId): Tenant | undefined;
    loadTeam(id: TeamId): Team | undefined;
    loadProject(id: ProjectId): Project | undefined;
    loadWorkspace(id: WorkspaceId): Workspace | undefined;
    loadGuestTrust(id: GuestTrustId): GuestTrust | undefined;
    loadRole(name: RoleName): Role | undefined;
    loadMembership(id: MembershipId): Membership | undefined;
    loadShareOffer(id: ShareOfferId): ShareOffer | undefined;
    teams(): readonly Team[];
    projects(): readonly Project[];
    workspaces(): readonly Workspace[];
    memberships(): readonly Membership[];
    guestTrusts(): readonly GuestTrust[];
    shareOffers(): readonly ShareOffer[];
}
export declare function sqliteScopeKey(scope: Membership["scope"]): string;
export declare function sqliteSubjectKey(subject: Membership["subject"]): string;
