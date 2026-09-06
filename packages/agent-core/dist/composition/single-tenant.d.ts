import { Binding, MemoryTenantControlStore, createTenantControlBootstrapPlan, type TenantControlBootstrapAnchor } from "../authority/index.js";
import type { BindingName, FacetRef, ProtectionDomain } from "../facets/index.js";
import { Workspace, type WorkspaceId } from "../identity/index.js";
export interface SingleTenantPolicyBinding {
    readonly name: BindingName;
    readonly domain: ProtectionDomain;
    readonly facet: FacetRef;
}
export interface SingleTenantPolicyAssemblyInit {
    readonly anchor: TenantControlBootstrapAnchor;
    readonly workspaceId: WorkspaceId;
    readonly binding: SingleTenantPolicyBinding;
}
export declare class TenantMultiplicityPolicy {
    readonly mode: "single-tenant" | "multi-tenant";
    private constructor();
    static singleTenant(): TenantMultiplicityPolicy;
    canCreateTenant(existingTenantCount: number): boolean;
    promote(): TenantMultiplicityPolicy;
}
export interface SingleTenantPolicyAssembly {
    readonly policy: TenantMultiplicityPolicy;
    readonly tenant: ReturnType<typeof createTenantControlBootstrapPlan>["tenant"];
    readonly owner: ReturnType<typeof createTenantControlBootstrapPlan>["owner"];
    readonly ownerMembership: ReturnType<typeof createTenantControlBootstrapPlan>["ownerMembership"];
    readonly grants: ReturnType<typeof createTenantControlBootstrapPlan>["grants"];
    readonly binding: Binding;
    readonly workspace: Workspace;
}
export declare function assembleSingleTenantPolicy(control: MemoryTenantControlStore, init: SingleTenantPolicyAssemblyInit): SingleTenantPolicyAssembly;
