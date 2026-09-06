import type { Membership, Role } from "../identity/index.js";
import { Grant } from "./grant.js";
import type { ScopeRef } from "../identity/index.js";
export interface RoleGrantMaterializationInput {
    readonly membership: Membership;
    readonly role: Role;
    readonly existing: readonly Grant[];
}
export declare class RoleGrantMaterialization {
    readonly desiredRecords: readonly Grant[];
    readonly changedRecords: readonly Grant[];
    readonly affectedScopes: readonly ScopeRef[];
    constructor(desiredRecords: readonly Grant[], changedRecords: readonly Grant[], affectedScopes: readonly ScopeRef[]);
    get semanticNoop(): boolean;
}
export declare class RoleGrantMaterializer {
    materialize(input: RoleGrantMaterializationInput): RoleGrantMaterialization;
}
