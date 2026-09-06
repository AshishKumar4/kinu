/**
 * Which enforcement tier serves a call (SPEC §7.2). Only `mediated` carries evidence: a
 * direct call performs its authority, lease, watermark, PathEpochEvidence, and deadline
 * checks in memory and writes nothing durable, so there is no Invocation for it to name.
 */
export type EnforcementTier = "direct" | "mediated";
/**
 * The impact an Operation declares, and the seam its request crosses (SPEC §4.2, §7.1).
 * The host derives impact from the seam, never from what the callee claims about itself.
 */
export type Impact = "observe" | "mutate" | "externalSend" | "execute" | "delegate" | "administer";
/**
 * SPEC §7.1 (C13-POLICY-IMPACT-BOUNDARY): a callee's own claim may replace the derived
 * impact only when it never admits a floor (§7.2) the derived impact would have mediated.
 * Checked under both Turn-owned-Session conditions, because a claim recorded once — at
 * discovery or install time — has to hold safe at every call site it is later used at.
 * `sessionFilesystemTarget` is fixed per caller: pass `false` for a seam whose target is
 * never a Turn-owned Session's own filesystem.
 */
export declare function claimHonorsEnforcementFloor(claimed: Impact, derived: Impact, sessionFilesystemTarget: boolean): boolean;
/**
 * SPEC §7.2's enforcement floor: the weakest tier this impact admits under the given
 * session conditions. Policy only tightens this floor; it never lowers it.
 */
export declare function enforcementFloor(impact: Impact, turnOwnedSession: boolean, sessionFilesystemTarget: boolean): EnforcementTier;
export declare const Impact: Readonly<{
    fromData(value: GeneratedData): Impact;
}>;
export type GeneratedData = boolean | bigint | number | string | null | undefined | readonly GeneratedData[] | {
    readonly [key: string]: GeneratedData;
};
export declare function requireBoolean(value: GeneratedData, name: string): boolean;
