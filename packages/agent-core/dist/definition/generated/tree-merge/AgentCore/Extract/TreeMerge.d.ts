export type TreeMergePolicyData = TreeMergePolicy["kind"];
/**
 * How a merge resolves the tree its two parents share (SPEC §5.2.1): take one side's tree
 * wholesale, or take per path the side that changed it relative to the common ancestor.
 */
export declare abstract class TreeMergePolicy {
    static get ours(): TreeMergePolicy;
    static get theirs(): TreeMergePolicy;
    static get perPath(): TreeMergePolicy;
    static from(kind: TreeMergePolicy["kind"]): TreeMergePolicy;
    static fromData(value: GeneratedData): TreeMergePolicy;
    abstract readonly kind: "ours" | "theirs" | "perPath";
    /**
     * The side a wholesale resolution records, and nothing when resolution is per path. A per-path
     * merge has no single side to record, which is exactly why it is the policy that can surface
     * a conflict.
     */
    abstract side(): Option<TreeMergeSide>;
    /**
     * Whether a path both sides changed is a conflict the operator resolves explicitly. A
     * wholesale policy has already answered every path by naming a side; only a per-path merge
     * can reach a path whose answer it does not have.
     */
    abstract surfacesConflicts(): boolean;
    toData(): TreeMergePolicyData;
    equals(other: TreeMergePolicy): boolean;
}
export declare class OursTreeMergePolicy extends TreeMergePolicy {
    readonly kind: "ours";
    constructor();
    side(): Option<TreeMergeSide>;
    surfacesConflicts(): boolean;
}
export declare class TheirsTreeMergePolicy extends TreeMergePolicy {
    readonly kind: "theirs";
    constructor();
    side(): Option<TreeMergeSide>;
    surfacesConflicts(): boolean;
}
export declare class PerPathTreeMergePolicy extends TreeMergePolicy {
    readonly kind: "perPath";
    constructor();
    side(): Option<TreeMergeSide>;
    surfacesConflicts(): boolean;
}
/**
 * The side of a merge a wholesale resolution takes the tree from (SPEC §5.2.1).
 */
export type TreeMergeSide = "ours" | "theirs";
export type GeneratedData = boolean | bigint | number | string | null | undefined | readonly GeneratedData[] | {
    readonly [key: string]: GeneratedData;
};
export type Option<A> = {
    readonly kind: "none";
} | {
    readonly kind: "some";
    readonly value: A;
};
