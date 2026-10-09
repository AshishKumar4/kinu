/**
 * Where the inspector (`inspectSubordinate`) reaches one of a hirer's helpers: by its actor, which the inspector reads
 * from the root at any depth, live or released (core subordinates/inspection-path.ts). A path walks live children by
 * name only and answers `missing` for a helper released once its work ended, as every task helper is, or dismissed.
 */

/** A helper as its hirer's roster lists it. */
export interface RosterHelper {
  readonly name: string;
  readonly status: string;
  readonly actorReference: { readonly actorId: string } | null;
}

/** One actor's place for the inspector: a path from the root, and the actor below it when the path cannot name it. */
export interface HelperAddress {
  readonly path: readonly string[];
  readonly actor?: string;
}

export const ROOT: HelperAddress = { path: [] };

/** `helper`, wherever it hangs: its actor from the root. A hire with no actor yet has only its name under the root. */
export function helperAddress(helper: RosterHelper): HelperAddress {
  return helper.actorReference === null ? { path: [helper.name] } : { path: [], actor: helper.actorReference.actorId };
}
