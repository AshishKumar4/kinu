import { RecordCodec, Revision } from "../core/index.js";
import { ProjectId, TenantId } from "./id.js";
export declare class Project {
    readonly id: ProjectId;
    readonly tenantId: TenantId;
    readonly revision: Revision;
    static get codec(): RecordCodec<Project>;
    readonly name: string;
    constructor(id: ProjectId, tenantId: TenantId, name: string, revision: Revision);
    static encode(project: Project): Uint8Array;
    static decode(bytes: Uint8Array): Project;
    rename(name: string): Project;
}
