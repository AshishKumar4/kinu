/**
 * How deep a subordinate tree may go, and how a child's room is DERIVED from
 * its parent's.
 *
 * The parent derives each child's depth before the child is seeded.
 * This policy governs creating agents, not work in an existing agent.
 *
 * The load-bearing property is that a child NEVER states its own depth. The
 * parent computes it (`deriveChildDelegationBudget`) and the seeding authority
 * writes it into the child's immutable identity row, so a subordinate that
 * simply does not check the cap cannot exceed it: the number it would have to
 * lie about is one it never supplies. Nothing decrements a live actor's budget
 * in place — an actor's depth is fixed for its whole life — so the same
 * structural containment the rest of this surface uses applies: at the cap the
 * team deps are not WIRED, and the actions they would have carried are absent
 * from the tool rather than offered and then refused (cf. heads/head-tools.ts,
 * which does not offer `split_subheads` to a head with no depth left).
 *
 * The runtime refusal below still exists, for the same reason head-tools keeps
 * `budgetExhausted` inside the tool it already gated at build time: a toolset is
 * cached across turns and a subordinate's identity is seeded AFTER its facet is
 * constructed, so a build that ran before the seed cannot have known the depth.
 */

import type { ErrorCode } from '../obs/error';

/**
 * The global cap on subordinate-tree depth: the workspace orchestrator is depth
 * 0, and depth 4 is the deepest subordinate that can exist. A depth-4
 * subordinate cannot hire — that child would be depth 5.
 *
 * One number, not a per-actor setting. A cap a caller can raise is not a cap,
 * and the tree it bounds is shared: every level runs on the same workspace
 * files and sandbox and charges the same owner.
 */
export const DELEGATION_MAX_DEPTH = 4;

/** Where an actor sits in its workspace's subordinate tree, and how much room
 *  is left below it. */
export interface DelegationBudget {
  /** 0 = the workspace orchestrator; 1 = a subordinate it hired; and so on. */
  readonly depth: number;
  /** Levels of hiring still available below this actor. 0 refuses. */
  readonly maxDepth: number;
}

/** The root of a workspace's tree: the orchestrator, with the whole cap below
 *  it. */
export const ROOT_DELEGATION_BUDGET: DelegationBudget = {
  depth: 0,
  maxDepth: DELEGATION_MAX_DEPTH,
};

/** An actor's budget from the one thing its identity row stores. Clamped at 0
 *  rather than going negative, so a row written by an older cap can only ever
 *  be MORE restrictive than the code reading it — and a stored negative depth
 *  reads as the root instead of inflating room past the cap. */
export function delegationBudgetAtDepth(depth: number): DelegationBudget {
  const safeDepth = Math.max(0, depth);
  return { depth: safeDepth, maxDepth: Math.max(0, DELEGATION_MAX_DEPTH - safeDepth) };
}

/**
 * The budget a hired subordinate inherits. Depth counts up, room counts down —
 * the two halves of the same decrement, kept together so a caller cannot take
 * one without the other.
 */
export function deriveChildDelegationBudget(parent: DelegationBudget): DelegationBudget {
  return { depth: parent.depth + 1, maxDepth: Math.max(0, parent.maxDepth - 1) };
}

/** Whether this actor may still hire. */
export function delegationExhausted(budget: DelegationBudget): boolean {
  return budget.maxDepth <= 0;
}

/**
 * The refusal at the cap, reason FIRST — the vocabulary `file-tool.ts` and the
 * fork seam already carry. `denied` and not `bad_input`: the arguments describe
 * a perfectly well-formed hire, and it is the POLICY that declines, which is
 * exactly what `denied` means (obs/error.ts). Both codes land in `refused`
 * rather than `broke` when the ledger is read back
 * (read-models/tool-failures.ts), so the distinction is not about where it
 * counts — it is about the answer being true.
 *
 * States the depth reached, because the useful next move differs by level: a
 * caller at the cap has to reach for something that is not a subordinate, and it
 * cannot tell that from "denied" alone.
 *
 * BOTH SPAWNING RUNGS reach this, which is why the wording does not say "hire"
 * alone: a role-targeted `ask` births a child through the identical substrate
 * and adds a level exactly as a hire does. A refusal that named only one of them
 * would describe a cap the other walked past.
 *
 * The refusal names one actionable remedy: a search, which performs work
 * without adding a subordinate level. `DELEGATION_MAX_DEPTH` bounds the
 * subordinate tree, while a search has its own `depth` cap, so a swarm at the
 * delegation cap is a different tree rather than a deeper subordinate tree.
 */
export interface DelegationDepthRefusal {
  readonly reason: Extract<ErrorCode, 'denied'>;
  readonly error: string;
}

export function delegationDepthRefusal(budget: DelegationBudget): DelegationDepthRefusal {
  return {
    reason: 'denied',
    error:
      `Cannot create an agent below this one: it is at delegation depth ${budget.depth} of the `
      + `global maximum ${DELEGATION_MAX_DEPTH}, so a child of it would be depth ${budget.depth + 1}. `
      + 'This covers BOTH lifetimes that birth a child — a durable hire and a `lifetime:"task"` '
      + 'hire — because they add a level through the same substrate. Hand the work to an agent '
      + 'that already exists with `hire` naming `agent` instead (that adds no depth), or run '
      + 'the work as a search: agents({action:"swarm", task, config:{context:"fork"}}) inherits '
      + 'your conversation and adds no depth to the subordinate tree.',
  };
}
