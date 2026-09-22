/**
 * The search's expansion budget. Spec: docs/EXPLORATION.md "Budget conservation".
 *
 * Grants to a node's children must sum to no more than the parent's remaining budget,
 * and node loops arbitrate concurrently. {@link SwarmBudget.arbitrate} decides and
 * debits synchronously, so nothing in `arbitrate` or `take` may become async
 * (`unit-swarm-budget.test.ts` asserts the sum of concurrent grants).
 *
 * A grant debits before its children exist, so a granted proposal that produces
 * nothing still consumed budget.
 */

import { arbitrateBranch } from './swarm';
import type { BranchArbitration, BranchArbitrationInput, BranchProposal } from './swarm';
import { nanoid } from '../utils/nanoid';

/** Ids are minted at debit time, so the ids a node's verdict names are the rows the engine writes (R13). */
export interface BranchGrant {
  readonly kind: 'granted';
  readonly width: number;
  readonly nodeIds: readonly string[];
  /** The engine expands from this, since the proposal exists only inside the node's tool call. */
  readonly proposal: BranchProposal;
}

export type BranchDecision = BranchGrant | Extract<BranchArbitration, { kind: 'refused' }>;

export class SwarmBudget {
  /** Never negative. */
  private left: number;

  private readonly total: number;

  constructor(total: number) {
    this.total = Math.max(0, total);
    this.left = this.total;
  }

  get remaining(): number {
    return this.left;
  }

  get committed(): number {
    return this.total - this.left;
  }

  /** Charges an engine-driven expansion and returns the narrower width the budget can pay for. */
  take(width: number): number {
    const charged = Math.min(Math.max(0, width), this.left);
    this.left -= charged;

    return charged;
  }

  /** Arbitrates and debits in one synchronous step; {@link arbitrateBranch} stays pure for the Lean port. */
  arbitrate(input: Omit<BranchArbitrationInput, 'remainingChildren'>): BranchDecision {
    const verdict = arbitrateBranch({ ...input, remainingChildren: this.left });

    if (verdict.kind === 'refused') return verdict;
    // No await between read and write. `accepted_within_budget` proves this stays non-negative.
    this.left -= verdict.width;

    return {
      kind: 'granted',
      width: verdict.width,
      nodeIds: Array.from({ length: verdict.width }, () => nanoid()),
      proposal: input.proposal,
    };
  }
}
