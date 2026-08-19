/**
 * WHERE THE NEXT UNIT OF BUDGET GOES — the `advance` axis, executable.
 *
 * One scheduler. Every `advance` value a run can reach resolves through this one
 * function, so there is no route by which a node expands without selection having
 * chosen it (§8.2: "a proposal is an input to selection, never a bypass of it").
 * The three policies here are what a run selects BY. `advance:'archive'` runs and
 * takes `none`'s single expansion off the root, because an archive is pinned to
 * depth 1 — it selects by CELL and its cells are written at the settle barrier, so
 * there is nothing inside one run to select from, and what makes it a distinct axis
 * value is the descriptor it bins by and the novelty test it admits against rather
 * than a frontier order. `pareto` reaches no run at all: it is refused for wanting
 * a per-instance or per-metric measurement this runner does not take
 * (`strategy/swarm-run.ts`).
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

/**
 * The `advance` values that select inside a running tree. `archive` and `pareto`
 * are absent for different reasons: an archive resolves to `none`'s one expansion
 * because it never selects a second level, and `pareto` is refused before anything
 * is selected.
 *
 * `beam` was here and is gone. It selected exactly what `best-first` selects and
 * differed only in ORDER — `depth ASC` made a whole level's beam expand before the
 * next level was entered — so it was a schedule wearing a selector's name. What
 * left with it is real and has no replacement here: the level-synchronised order
 * and the `beamWidth` that ranked each level. A level BARRIER survives as a
 * concept because shared compaction and comparative sibling judging both need one,
 * but it belongs to a level rather than to this switch.
 */
export type FrontierPolicy = 'uct' | 'best-first' | 'none';

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
