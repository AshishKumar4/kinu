import type { RunCommitId } from "../../execution-references/index.js";
import type { InvocationId } from "../../interaction-references/index.js";
import type { RunCommit } from "./commit.js";
/**
 * Resolves a commit identity to its record. A caller validating a commit it has not yet
 * inserted answers for that identity itself, so the same derivation decides a prospective
 * cut and an installed one.
 */
export type RunCommitLoader = (id: RunCommitId) => RunCommit | undefined;
/**
 * Which commit a branch head is current at: an undo marker answers with its selection,
 * every other head with itself. It sits beside the transcript derivation because every
 * caller that asks what a model reads MUST resolve the head first — §5.6 assembles from
 * the effective state and not from the raw head, which may be an undo marker.
 */
export declare function effectiveCommitOf(load: RunCommitLoader, head: RunCommitId): RunCommit;
/**
 * The ancestors of `base` including itself, every parent before its child, and a merge's
 * first-parent ancestry before the commits only its second parent reaches. Parent order is
 * recorded, so this order is a property of the graph rather than of the walk.
 */
export declare function orderedAncestry(base: RunCommit, load: RunCommitLoader): readonly RunCommit[];
/**
 * The model-visible sequence a call reads at `base`: that commit's ancestry in commit
 * order with every shadowed commit omitted and each installed rewrite read where the
 * earliest commit it shadows stood. `base` is the effective state, already resolved
 * through any undo selection, so a rewrite appended later is a descendant and cannot
 * enter the derivation.
 */
export declare function effectiveTranscript(base: RunCommit, load: RunCommitLoader): readonly RunCommit[];
/** Which Invocation a cut left half-recorded, and the half that survived it. */
export interface UnbalancedCut {
    readonly kind: "unanswered" | "orphaned";
    readonly invocation: InvocationId;
    readonly commit: RunCommitId;
}
/**
 * The first Invocation whose request and `invocation` commit the cut separated. Judged on
 * identity rather than on how many of each survived: a cut that drops one request and one
 * unrelated result leaves any count balanced and strands both surviving halves.
 */
export declare function unbalancedCut(before: readonly RunCommit[], after: readonly RunCommit[]): UnbalancedCut | undefined;
