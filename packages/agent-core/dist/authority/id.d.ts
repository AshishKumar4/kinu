import { TextId } from "../core/index.js";
type IdentityIdInput = string | {
    readonly value: string;
};
export declare class GrantId extends TextId {
    constructor(value: string);
    static forRole(membership: IdentityIdInput, ruleOrdinal: number): GrantId;
}
export {};
