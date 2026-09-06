import type { JsonValue } from "../core/index.js";
import { ProjectId, TenantId, WorkspaceId } from "./id.js";
export type ScopeKind = "tenant" | "project" | "workspace";
export declare class ScopeRef {
    readonly kind: ScopeKind;
    readonly tenantId: TenantId;
    readonly projectId: ProjectId | undefined;
    readonly workspaceId: WorkspaceId | undefined;
    private constructor();
    static tenant(tenantId: TenantId): ScopeRef;
    static project(tenantId: TenantId, projectId: ProjectId): ScopeRef;
    static workspace(tenantId: TenantId, workspaceId: WorkspaceId): ScopeRef;
    static workspace(tenantId: TenantId, projectId: ProjectId, workspaceId: WorkspaceId): ScopeRef;
    get path(): readonly ScopeRef[];
    equals(other: ScopeRef): boolean;
}
export declare function encodeScopeRef(scope: ScopeRef): JsonValue;
export declare function decodeScopeRef(value: JsonValue): ScopeRef;
export declare function scopePath(scope: ScopeRef): readonly ScopeRef[];
