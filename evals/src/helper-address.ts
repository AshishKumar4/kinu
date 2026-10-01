/**
 * Where the inspector (`inspectSubordinate`) reaches one of a hirer's helpers. A path walks live children only, so a
 * helper released once its work ended, as every task helper is, is reached by its actor from the root, the inspector's
 * one read of a retained actor (core subordinates/inspection-path.ts). A build whose inspector predates actor reads
 * (2f660875cc) still reaches every live helper by its name.
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

/** `helper`, under the hirer at `hirer`. */
export function helperAddress(hirer: HelperAddress, helper: RosterHelper): HelperAddress {
  const named = hirer.actor === undefined && helper.status !== 'dismissed';

  if (named || helper.actorReference === null) return { path: [...hirer.path, helper.name] };

  return { path: [], actor: helper.actorReference.actorId };
}
