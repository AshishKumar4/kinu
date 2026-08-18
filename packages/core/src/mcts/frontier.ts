/**
 * WHERE THE NEXT UNIT OF BUDGET GOES — the `advance` axis, executable.
 *
 * One scheduler. Every `advance` value a run can reach resolves through this one
 * function, so there is no route by which a node expands without selection having
 * chosen it (§8.2: "a proposal is an input to selection, never a bypass of it").
 * The four values here are the four that reach a run; `archive` and `pareto` need
 * a store the objective-scored runner has no writer for and are refused before
 * anything is selected (`strategy/swarm-run.ts`).
 *
 * THE DEPTH CAP IS A WHERE-CLAUSE EXCLUSION IN EVERY ARM, never a search abort —
 * the WP-A4 discipline `uct.ts` states and the reason §10.1 files S3 as "true by
 * construction". A node at the cap is skipped and the budget keeps flowing to the
 * shallower frontier. Because a child's `depth` is written by the engine as its
 * parent's plus one, and this clause reads that column, a node cannot reach depth
 * `maxDepth + 1` by any route: the number it would have to lie about is one it
 * never supplies (`subordinates/depth.ts`).
 *
 * WHAT "FRONTIER" MEANS, AND WHY UCT IS THE ONE ARM THAT IGNORES IT. For `beam`,
 * `best-first` and `none` an expanded node is DONE — those three are frontier
 * searches, and the frontier is the set of nodes with no children yet, read off
 * the tree (`NOT EXISTS` on `parent_id`) rather than off a mutable flag. UCT is
 * different on purpose: re-selecting an expanded node IS re-widening, which
 * `uct.ts` implements deliberately and which this module must not undo.
 */

import type { SqlExecutor } from '../types/primitives';
import type { SearchNode } from '../types/mcts';
import { selectNode } from './uct';

/** The `advance` values that select inside a running tree. `archive` and `pareto`
 *  are absent because they report a store rather than descend a tree. */
export type FrontierPolicy = 'uct' | 'beam' | 'best-first' | 'none';

export interface FrontierInput {
  /** This search's own tree. Scoped for the reason `uct.ts` states: an unscoped
   *  argmax lets an abandoned tree capture the next task's budget. */
  readonly rootId: string;
  readonly policy: FrontierPolicy;
  /** The resolved `depth` cap. A node at or past it is excluded, never selected
   *  and then rejected. */
  readonly maxDepth: number;
  /** UCT's exploration constant. Read only by the `uct` arm — the axis says so. */
  readonly explorationWeight: number;
  /** The beam's width: how many nodes of one level stay in the beam. Read only by
   *  the `beam` arm. */
  readonly beamWidth: number;
}

/**
 * The next node to expand, or null when nothing is selectable — the frontier is
 * exhausted, or every open node sits at the depth cap.
 *
 * Null is a SETTLED search rather than an error, which is what lets the caller
 * report "settled" against "budget" honestly.
 */
export function selectFrontierNode(sql: SqlExecutor, input: FrontierInput): SearchNode | null {
  const { rootId, maxDepth } = input;
  switch (input.policy) {
    case 'uct':
      return selectNode(sql, rootId, input.explorationWeight, maxDepth);
    case 'best-first':
      return bestUnexpanded(sql, rootId, maxDepth);
    case 'beam':
      return bestInBeam(sql, rootId, maxDepth, input.beamWidth);
    case 'none':
      return unexpandedRoot(sql, rootId, maxDepth);
  }
}

/**
 * Greedy best-first: the highest-valued node that has not been expanded.
 *
 * This is `uct` with the exploration term removed, and it is written as its own
 * query rather than as `selectNode(..., 0, ...)` because the two differ in more
 * than the constant: best-first takes each node once, so it reads the frontier,
 * while UCT re-selects to re-widen. Passing a zero weight would have made a
 * greedy search that can re-pick the parent it just expanded whenever the
 * parent's backpropagated mean ties its best child — a stall, not a search.
 */
function bestUnexpanded(sql: SqlExecutor, rootId: string, maxDepth: number): SearchNode | null {
  return sql<SearchNode>`
    SELECT s.* FROM search_nodes s
    WHERE s.root_id = ${rootId} AND s.status = 'open' AND s.depth < ${maxDepth}
      AND NOT EXISTS (SELECT 1 FROM search_nodes c WHERE c.parent_id = s.id)
    ORDER BY s.value DESC, s.created_at ASC, s.id ASC
    LIMIT 1
  `[0] ?? null;
}

/**
 * Beam search: the best unexpanded node of the SHALLOWEST level that still has one,
 * provided it is inside the beam.
 *
 * `depth ASC` is what makes the search level-synchronous — a whole level's beam is
 * expanded before the next level is entered — and the rank subquery IS the beam: a
 * node is in it when fewer than `width` nodes of its own level precede it in the
 * total order (value, then age, then id). Stated as a rank rather than by retiring
 * the losers, because `status` already means four things and "outside the beam" is
 * none of them: a node dropped from a beam was not pruned for low value and did not
 * fail.
 *
 * THE RANK IS OVER THE WHOLE LEVEL AND THE `NOT EXISTS` APPLIES ONLY TO THE
 * CANDIDATE, which is the difference between a beam and a queue. Counting only the
 * level's *unexpanded* nodes looked equivalent and was not: as the beam's own members
 * got expanded they left the count, the nodes below them rose into the width, and a
 * node the beam had rejected was silently promoted — so a beam of 2 eventually
 * expanded all four members of a level and never descended. Measured as exactly that:
 * a depth-1 node selected where the beam should already have moved to depth 2.
 *
 * The order is TOTAL — ties fall through to `created_at` and then `id` — so a beam is
 * reproducible rather than dependent on row order.
 */
function bestInBeam(
  sql: SqlExecutor, rootId: string, maxDepth: number, width: number,
): SearchNode | null {
  return sql<SearchNode>`
    SELECT s.* FROM search_nodes s
    WHERE s.root_id = ${rootId} AND s.status = 'open' AND s.depth < ${maxDepth}
      AND NOT EXISTS (SELECT 1 FROM search_nodes c WHERE c.parent_id = s.id)
      AND (
        SELECT COUNT(*) FROM search_nodes o
        WHERE o.root_id = ${rootId} AND o.status = 'open' AND o.depth = s.depth
          AND (o.value > s.value
            OR (o.value = s.value AND o.created_at < s.created_at)
            OR (o.value = s.value AND o.created_at = s.created_at AND o.id < s.id))
      ) < ${width}
    ORDER BY s.depth ASC, s.value DESC, s.created_at ASC, s.id ASC
    LIMIT 1
  `[0] ?? null;
}

/**
 * `advance:'none'`: the root, and only while it has never been expanded.
 *
 * A flat run's one wave, expressed as a selection rather than as a special case
 * outside the scheduler — which is what keeps "one scheduler" a fact about the
 * code. It also states the refusal `swarmValidity` gives for `depth > 1` here in
 * executable form: with no selection step there is no second level to reach,
 * because after the first expansion this returns null.
 */
function unexpandedRoot(sql: SqlExecutor, rootId: string, maxDepth: number): SearchNode | null {
  return sql<SearchNode>`
    SELECT s.* FROM search_nodes s
    WHERE s.id = ${rootId} AND s.status = 'open' AND s.depth < ${maxDepth}
      AND NOT EXISTS (SELECT 1 FROM search_nodes c WHERE c.parent_id = s.id)
    LIMIT 1
  `[0] ?? null;
}
