import { RecordCodec, type JsonValue } from "../core/index.js";
import { enforcementFloor, type EnforcementTier, type Impact, type IsolationMode } from "../facets/index.js";
import { PlacementPolicy } from "./placement.js";
import { TreeMergePolicy, type TreeMergePolicyData } from "./generated/tree-merge/AgentCore/Extract/TreeMerge.js";
export { enforcementFloor };
export type { EnforcementTier } from "../facets/index.js";
export type EnforcementTierOverrides = Readonly<Partial<Record<Impact, EnforcementTier>>>;
export declare const POLICY_IMPACTS: readonly Impact[];
/**
 * SPEC §5.2.1: how a merge resolves the tree its two parents share. The three settings are
 * the whole vocabulary and the platform never picks silently, so this is a value object
 * whose cases carry the two facts a merge needs — which side a wholesale resolution
 * records, and whether a path changed on both sides is a conflict the operator resolves.
 * Absence is not a fourth setting: a Blueprint that omits it declares a platform whose
 * branches own disjoint Environments, and a merge that would need a side is rejected
 * rather than guessed (C13-RUN-TREE-CONFLICT-EXPLICIT).
 *
 * The vocabulary, both facts, and the frozen singleton per case are lowered by the TSLean
 * compiler from `formal/AgentCore/Extract/TreeMerge.lean`; only the absence-tolerant
 * decode below is this context's, because absence is a Blueprint fact and not a merge one.
 */
export { TreeMergePolicy };
export type TreeMergeSetting = TreeMergePolicyData;
/** The declared policy, or nothing where the Blueprint declares none (SPEC §9.2). */
export declare function treeMergePolicyFromData(value: JsonValue | undefined): TreeMergePolicy | undefined;
export interface PolicySetInit {
    readonly tiers?: EnforcementTierOverrides;
    readonly approvals?: readonly Impact[];
    readonly placement: PlacementPolicy;
    readonly maxDirectRevocationWindowMs?: number;
    readonly treeMerge?: TreeMergePolicy;
}
export declare class PolicySet {
    static get codec(): RecordCodec<PolicySet>;
    readonly tiers: EnforcementTierOverrides;
    readonly approvals: readonly Impact[];
    readonly placement: PlacementPolicy;
    readonly maxDirectRevocationWindowMs: number | undefined;
    /**
     * Present only when the Blueprint declares it. Absence is the declaration that this
     * platform's branches own disjoint Environments, so a merge needing a side is refused.
     */
    readonly treeMerge: TreeMergePolicy | undefined;
    constructor(init: PolicySetInit);
    static empty(): PolicySet;
    static encode(policy: PolicySet): Uint8Array;
    static decode(bytes: Uint8Array): PolicySet;
    static fromData(payload: JsonValue): PolicySet;
    tierFor(impact: Impact): EnforcementTier | undefined;
    requiresApproval(impact: Impact): boolean;
    toData(): JsonValue;
}
export interface PolicyEvaluationInput {
    readonly impact: Impact;
    readonly turnOwnedSession: boolean;
    /**
     * True only when the operation's target is the Turn-owned Session's own
     * filesystem (SPEC §7.2). Required so a caller that cannot attest the fact
     * states false explicitly; a mutate outside that filesystem stays mediated.
     */
    readonly sessionFilesystemTarget: boolean;
    readonly placement: IsolationMode;
    readonly policies?: readonly PolicySet[];
}
export interface PolicyDecision {
    readonly tier: EnforcementTier;
    readonly approvalRequired: boolean;
}
export declare function evaluatePolicy(input: PolicyEvaluationInput): PolicyDecision;
export declare function mergePolicySets(policies: readonly PolicySet[]): PolicySet;
