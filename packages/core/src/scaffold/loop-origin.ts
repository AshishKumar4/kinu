/**
 * Loop-origin data, kept free of value imports so type-importing it (via
 * `heads/types.ts`) does not pull `bootstrap.ts`'s evolution-gate imports onto
 * the turn spine's graph.
 */

import type { WorkspaceActor } from '../identity/workspace-actors';

/**
 * Where a created actor's agentic loop comes from. Explicit at every creation
 * site; "no origin" is not representable.
 */
export type LoopOrigin =
  | { readonly kind: 'builtin' }
  /** This actor starts from its parent's current version's retained source. */
  | { readonly kind: 'inherit' }
  | { readonly kind: 'version'; readonly version: number };

/**
 * The origin a kind takes when its creator names none. Searches share the
 * parent's loop; hired subordinates and temporaries start from the bootstrap.
 */
export function defaultLoopOrigin(kind: WorkspaceActor['kind']): LoopOrigin {
  return kind === 'head' || kind === 'branch' ? { kind: 'inherit' } : { kind: 'builtin' };
}
