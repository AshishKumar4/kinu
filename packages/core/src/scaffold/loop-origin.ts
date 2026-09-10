/**
 * WHICH LOOP AN ACTOR STARTS FROM, as data.
 *
 * Split out of `scaffold/bootstrap.ts` for a reason that is structural rather
 * than tidy: `HeadInput.loop` made this type REQUIRED, so `heads/types.ts`
 * type-imports it, and every module that type-imports `heads/types.ts` — the
 * turn spine, heads support, signal delivery — then had `scaffold/bootstrap.ts`
 * on its import graph. Bootstrap value-imports `scaffold/shadow.ts`, which
 * value-imports the evolution gate's `checkMisevolution`, so the layer gate
 * read the turn driver as reaching the evolution gate: nine violations from one
 * type import. Erased at runtime, real to any tool that walks specifiers.
 *
 * So the DATA lives here, with no value import of its own, and the behaviour
 * that acts on it stays in `bootstrap.ts`. `bootstrap.ts` re-exports both names
 * so no caller had to move.
 */

import type { WorkspaceActor } from '../identity/workspace-actors';

/**
 * Where a created actor's agentic loop comes from.
 *
 * Explicit at every creation site, because the alternative is what the
 * exploration kinds did: a head and a hosted node opened a FRESH private
 * scaffold store, found no row, and ran the builtin v0 — so a workspace whose
 * owner had promoted three generations of loop still explored with the
 * bootstrap one, and nothing said so. "No origin" is not representable here for
 * the same reason `CapabilityStatus` has no fourth state.
 */
export type LoopOrigin =
  /** This actor starts from the shipped bootstrap loop and evolves its own. */
  | { readonly kind: 'builtin' }
  /** This actor starts from its parent's CURRENT version's retained source. */
  | { readonly kind: 'inherit' }
  /** This actor starts from one named version of its parent's lineage. */
  | { readonly kind: 'version'; readonly version: number };

/**
 * The origin a kind takes when its creator names none.
 *
 * A search explores under the loop it is searching FOR — a head exploring in
 * swarm mode that reasoned with the bootstrap loop while its parent runs a
 * promoted one is measuring the wrong program, and the local swarm node already
 * shared its parent's pointer for exactly that reason. A hired subordinate and
 * an ask-by-role temporary have their own role and their own evolution, so they
 * start where the product starts. Every creation site still records what it
 * used: this is the default, not a silence.
 */
export function defaultLoopOrigin(kind: WorkspaceActor['kind']): LoopOrigin {
  return kind === 'head' || kind === 'branch' ? { kind: 'inherit' } : { kind: 'builtin' };
}
