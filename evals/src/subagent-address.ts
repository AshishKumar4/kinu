/**
 * Where the inspector (`inspectSubagent`) reaches one of a hirer's subagents: by its actor, which the inspector reads
 * from the root at any depth, live or released (core subagents/inspection-path.ts). A path walks live children by
 * name only and answers `missing` for a subagent released once its work ended, as every task subagent is, or dismissed.
 */

/** A subagent as its hirer's roster lists it. */
export interface RosterSubagent {
  readonly name: string;
  readonly status: string;
  readonly actorReference: { readonly actorId: string } | null;
}

/** One actor's place for the inspector: a path from the root, and the actor below it when the path cannot name it. */
export interface SubagentAddress {
  readonly path: readonly string[];
  readonly actor?: string;
}

export const ROOT: SubagentAddress = { path: [] };

/** `subagent`, wherever it hangs: its actor from the root. A hire with no actor yet has only its name under the root. */
export function subagentAddress(subagent: RosterSubagent): SubagentAddress {
  return subagent.actorReference === null ? { path: [subagent.name] } : { path: [], actor: subagent.actorReference.actorId };
}
