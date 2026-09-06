/**
 * Where a Package's code runs (SPEC §1.5, §9.2). The three modes are the whole vocabulary;
 * the order they are declared in is the preference order `preferred` walks.
 */
export type IsolationMode = "dynamic" | "provider" | "bundled";
export interface PlacementIntersectionInit {
    readonly dynamic: boolean;
    readonly provider: boolean;
    readonly bundled: boolean;
}
export interface PlacementIntersectionData {
    readonly dynamic: boolean;
    readonly provider: boolean;
    readonly bundled: boolean;
}
/**
 * The modes admitted by all four independently derived sets (SPEC §9.2): what the Facet's
 * manifest declares, what the Blueprint's policy allows, what the substrate profile offers,
 * and what the trust policy admits for the Package. Carrying the intersection as its own
 * value is what keeps "admissible" and "preferred" separate: the intersection is derived
 * once, and the preference order is applied to it once.
 */
export declare class PlacementIntersection {
    readonly dynamic: boolean;
    readonly provider: boolean;
    readonly bundled: boolean;
    constructor(init: PlacementIntersectionInit);
    static fromData(value: GeneratedData): PlacementIntersection;
    /**
     * The mode served, as SPEC §9.2's one fixed preference order decides it: the first member of
     * the intersection in the order `dynamic`, `provider`, `bundled`. There is no second ordering
     * and no fallback for an empty intersection — that case has no answer, and the caller rejects.
     */
    preferred(): Option<IsolationMode>;
    toData(): PlacementIntersectionData;
    equals(other: PlacementIntersection): boolean;
}
/**
 * Whether a source's admissible-mode set contains this mode. A source arrives as the list of
 * modes it admits, which is how every caller already holds it, and membership is decided per
 * mode so the answer never depends on the order a source happened to list its modes in.
 */
export declare function admitsMode(modes: readonly IsolationMode[], mode: IsolationMode): boolean;
/**
 * SPEC §9.2's placement decision end to end: intersect the four admissible-mode sets, then
 * serve the first member of the intersection in the fixed preference order.
 */
export declare function preferredPlacement(manifest: readonly IsolationMode[], policy: readonly IsolationMode[], substrate: readonly IsolationMode[], trust: readonly IsolationMode[]): Option<IsolationMode>;
export declare const IsolationMode: Readonly<{
    fromData(value: GeneratedData): IsolationMode;
}>;
export type GeneratedData = boolean | bigint | number | string | null | undefined | readonly GeneratedData[] | {
    readonly [key: string]: GeneratedData;
};
export type Option<A> = {
    readonly kind: "none";
} | {
    readonly kind: "some";
    readonly value: A;
};
export declare function requireList<A>(value: GeneratedData, name: string, element: (value: GeneratedData, name: string) => A): readonly A[];
