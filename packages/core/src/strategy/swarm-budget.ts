/**
 * The search's expansion budget, and the ONE thing allowed to move it.
 *
 * Specified by docs/EXPLORATION.md — "Budget conservation" and "A node is an agent".
 *
 * WHY THIS IS A TYPE AND NOT A `let`. It was a `let childBudget` in the run loop
 * for as long as a node was one toolless generation, and that was sound for a
 * reason that has now stopped being true: nothing ran between reading the number
 * and writing it back, because arbitration happened in the run loop itself, one
 * node at a time. A node is now an agent (*A node is an agent*), so it asks for its
 * branches from inside its own tool loop, and N node loops run concurrently. Two of
 * them reading the same `remaining` and both being granted is the hole *Budget
 * conservation* names: the allocations an arbiter grants to a node's children MUST sum
 * to no more than the parent's remaining budget. Depth and width bound the SHAPE;
 * conservation bounds the SPEND, and without it one branch that keeps proposing eats
 * the run while every individual grant looks legal.
 *
 * HOW IT IS CLOSED, and it is closed by construction rather than by a lock.
 * {@link SwarmBudget.arbitrate} decides and DEBITS in one synchronous function
 * with no `await` anywhere between the read and the write, so on a single-threaded
 * runtime there is no interleaving point for a second caller to observe the
 * pre-debit number. That is why this file has no mutex: a mutex would be a
 * defence against a suspension point that does not exist, and adding one would
 * invite a future `await` to be added inside the critical section, which is the
 * only way the hole comes back. The rule is stated as a rule because it is not
 * visible from the call site: **nothing in `arbitrate` or `take` may become
 * async.** `unit-swarm-budget.test.ts` drives concurrent proposals against one
 * budget and asserts the sum of grants, so a future `await` here fails a test
 * rather than overspending a search.
 *
 * A DEBIT IS NOT A SPEND. Reserving children commits the budget at the moment a
 * grant is made, before the children exist, which is deliberate: a proposal that
 * was granted and then produced nothing has still consumed the room the search
 * would otherwise have selected into, and a budget that only counted children
 * that came back would let a failing provider buy unbounded expansions. That is
 * the same reason the run loop has always charged an expansion whose model call
 * was rejected.
 */

import { arbitrateBranch } from './swarm';
import type { BranchArbitration, BranchArbitrationInput, BranchProposal } from './swarm';
import { nanoid } from '../utils/nanoid';

/**
 * An accepted proposal, with the children it PAID for.
 *
 * The ids are minted here, at the moment the budget is debited, so the ids a node
 * is told about in its verdict are the ids the engine later writes rows for. A
 * grant that named no children would leave the node's transcript unable to say
 * which nodes its request produced, which is R13's whole point one level down.
 */
export interface BranchGrant {
  readonly kind: 'granted';
  readonly width: number;
  readonly nodeIds: readonly string[];
  /** The branches this grant paid for. Carried on the grant rather than looked up
   *  later, because an agent node's proposal exists only inside the tool call that
   *  made it — the engine expands from what it granted, never from what it
   *  remembers. */
  readonly proposal: BranchProposal;
}

/** What arbitration returned: children paid for, or the refusal that named why. */
export type BranchDecision = BranchGrant | Extract<BranchArbitration, { kind: 'refused' }>;

export class SwarmBudget {
  /** Children the search may still create. Never negative: the floor is what
   *  makes "is there room" one comparison for every reader. */
  private left: number;

  private readonly total: number;

  constructor(total: number) {
    this.total = Math.max(0, total);
    this.left = this.total;
  }

  /** Children still available. Read by the arbiter and by the run loop's
   *  continuation test, and it is the same number for both. */
  get remaining(): number {
    return this.left;
  }

  get committed(): number {
    return this.total - this.left;
  }

  /**
   * Charge an engine-driven expansion, and return the width it can actually pay for.
   *
   * `min(asked, remaining)` rather than "charge it all and floor at zero": both give the
   * same answer for every wave a search without grants ever runs, because the budget is
   * `depth * branches` and each wave takes exactly `branches`. They differ once a GRANT
   * has taken part of the budget mid-level, and then the honest answer is the narrower
   * wave — a search that ran a full-width wave off an empty budget would have created
   * children nothing paid for, which is the same overspend from the other direction.
   */
  take(width: number): number {
    const charged = Math.min(Math.max(0, width), this.left);
    this.left -= charged;
    return charged;
  }

  /**
   * Arbitrate one proposal and, if it is accepted, debit its width in the SAME
   * synchronous step.
   *
   * The arbiter itself stays pure and total ({@link arbitrateBranch}) — this adds
   * conservation and nothing else, so the five refusal policies, their order and
   * their prose are unchanged and the Lean port still reads against the same
   * function.
   */
  arbitrate(input: Omit<BranchArbitrationInput, 'remainingChildren'>): BranchDecision {
    const verdict = arbitrateBranch({ ...input, remainingChildren: this.left });
    if (verdict.kind === 'refused') return verdict;
    // The read above and the write below with nothing between them: see the
    // header. `verdict.width <= this.left` is `accepted_within_budget`, which is
    // proved of the arbiter, so this cannot drive `left` negative.
    this.left -= verdict.width;
    return {
      kind: 'granted',
      width: verdict.width,
      nodeIds: Array.from({ length: verdict.width }, () => nanoid()),
      proposal: input.proposal,
    };
  }
}
