import { RecordCodec, Revision } from "../core/index.js";
import { ProjectId, TenantId, WorkspaceId } from "./id.js";
import { ScopeRef } from "./scope.js";
export declare class Workspace {
    readonly id: WorkspaceId;
    readonly tenantId: TenantId;
    readonly projectId: ProjectId | undefined;
    readonly revision: Revision;
    static get codec(): RecordCodec<Workspace>;
    constructor(id: WorkspaceId, tenantId: TenantId, projectId: ProjectId | undefined, revision: Revision);
    static encode(workspace: Workspace): Uint8Array;
    static decode(bytes: Uint8Array): Workspace;
    get scope(): ScopeRef;
}
