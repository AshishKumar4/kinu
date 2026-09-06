import { RecordCodec } from "../core/index.js";
import { CapabilitySpec, type CapabilityEffect, type Impact } from "../facets/index.js";
import { RoleName } from "./id.js";
export type RoleRuleEffect = CapabilityEffect;
export type RoleImpact = Impact;
export declare class RoleRule {
    readonly effect: RoleRuleEffect;
    readonly capability: CapabilitySpec;
    constructor(effect: RoleRuleEffect, capability: CapabilitySpec);
}
export declare class Role {
    readonly name: RoleName;
    static get codec(): RecordCodec<Role>;
    readonly rules: readonly RoleRule[];
    constructor(name: RoleName, rules: readonly RoleRule[]);
    static encode(role: Role): Uint8Array;
    static decode(bytes: Uint8Array): Role;
}
export declare const OWNER_ROLE: Role;
export declare const EDITOR_ROLE: Role;
export declare const READER_ROLE: Role;
export declare const BUILT_IN_ROLES: readonly Role[];
export declare function findBuiltInRole(name: RoleName | string): Role | undefined;
