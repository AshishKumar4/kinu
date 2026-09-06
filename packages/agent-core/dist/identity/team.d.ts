import { RecordCodec, Revision } from "../core/index.js";
import { PrincipalId, TeamId, TenantId } from "./id.js";
export declare class Team {
    readonly id: TeamId;
    readonly tenantId: TenantId;
    readonly revision: Revision;
    static get codec(): RecordCodec<Team>;
    readonly name: string;
    readonly principals: readonly PrincipalId[];
    constructor(id: TeamId, tenantId: TenantId, name: string, principals: readonly PrincipalId[], revision: Revision);
    static encode(team: Team): Uint8Array;
    static decode(bytes: Uint8Array): Team;
    has(principal: PrincipalId): boolean;
    revise(name: string, principals: readonly PrincipalId[]): Team;
}
