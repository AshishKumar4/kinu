import type { ScopeRef } from "../identity/index.js";
import { ScopeEpoch } from "./epoch.js";
type NonEmptyScopes = readonly [ScopeRef, ...ScopeRef[]];
export type ResolverInputMutation = {
    readonly kind: "grant";
    readonly scope: ScopeRef;
} | {
    readonly kind: "membership";
    readonly affectedScopes: NonEmptyScopes;
} | {
    readonly kind: "role";
    readonly affectedScopes: NonEmptyScopes;
} | {
    readonly kind: "teamClosure";
    readonly affectedScopes: NonEmptyScopes;
} | {
    readonly kind: "principalClosure";
    readonly affectedScopes: NonEmptyScopes;
} | {
    readonly kind: "guestVerification";
    readonly affectedScopes: NonEmptyScopes;
} | {
    readonly kind: "topology";
    readonly affectedScopes: NonEmptyScopes;
} | {
    readonly kind: "lifecycle";
    readonly affectedScopes: NonEmptyScopes;
} | {
    readonly kind: "policy";
    readonly affectedScopes: NonEmptyScopes;
} | {
    readonly kind: "trust";
    readonly affectedScopes: NonEmptyScopes;
} | {
    readonly kind: "bindingTransition";
    readonly affectedScopes: NonEmptyScopes;
};
export declare class EpochPlan {
    readonly next: readonly ScopeEpoch[];
    readonly bumped: readonly ScopeEpoch[];
    readonly affectedScopes: readonly ScopeRef[];
    constructor(next: readonly ScopeEpoch[], bumped: readonly ScopeEpoch[]);
}
export declare class EpochPlanner {
    plan(current: readonly ScopeEpoch[], mutations: readonly ResolverInputMutation[]): EpochPlan;
}
export {};
