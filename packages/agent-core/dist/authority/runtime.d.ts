import type { ActorRef } from "../actors/index.js";
import type { Principal, PrincipalId, GuestTrust, GuestTrustId, Membership, MembershipId, ScopeRef, Team, TenantId, WorkspaceId, Workspace } from "../identity/index.js";
import { Binding } from "./binding.js";
import type { BindingValidationRequest } from "./binding-evidence.js";
import { BindingValidationEvidence } from "./binding-evidence.js";
import { AuthorityCheckEvidence, type AuthorityCheckRequest } from "./evidence.js";
import { type ScopeEpoch } from "./epoch.js";
import type { Grant } from "./grant.js";
import type { GrantId } from "./id.js";
export interface TenantAuthorityReadStore {
    readonly tenantId: TenantId;
    principal(id: PrincipalId): Principal | undefined;
    teams(): readonly Team[];
    workspace(id: WorkspaceId): Workspace | undefined;
    membership(id: MembershipId): Membership | undefined;
    guestTrust(id: GuestTrustId): GuestTrust | undefined;
    binding(key: string): Binding | undefined;
    grant(id: GrantId): Grant | undefined;
    grants(): readonly Grant[];
    epoch(scope: ScopeRef): ScopeEpoch;
}
export declare class TenantAuthorityRuntime {
    private readonly store;
    private readonly issuer;
    constructor(store: TenantAuthorityReadStore, issuer: ActorRef);
    validateBinding(request: BindingValidationRequest, now: Date): BindingValidationEvidence;
    check(request: AuthorityCheckRequest, now: Date): AuthorityCheckEvidence;
    private evaluate;
    private effectiveSubjects;
    private currentPath;
    private guestGrantIsCurrent;
    private requireWorkspace;
    private requireTenant;
}
