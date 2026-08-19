/**
 * BUDGET CONSERVATION, and the race that makes it a type instead of a `let`.
 *
 * EXPLORATION-SPEC §8.11 states the rule this file is about: *"the allocations an
 * arbiter grants to a node's children MUST sum to no more than the parent's remaining
 * budget. Depth and width bound the SHAPE; conservation bounds the SPEND, and without
 * it one branch that keeps proposing eats the run while every individual grant looks
 * legal."*
 *
 * WHY THE RACE IS REAL NOW AND WAS NOT BEFORE. A toolless node's proposal was answered
 * in the run loop, one node at a time, so nothing could run between reading the
 * remaining budget and spending it. An AGENT node asks from inside its own tool loop
 * and N of those run concurrently under one `Promise.allSettled`, so two nodes reading
 * the same `remaining` and both being granted is reachable. The audit named it as a
 * hole; these tests are what keeps it closed.
 *
 * THE MUTATION THIS SUITE IS BUILT TO CATCH, stated because a passing test proves
 * nothing unless the failure it excludes is named: replacing `arbitrate`'s
 * decide-and-debit with a read, an `await`, and then a debit — the shape a refactor
 * produces by adding one innocuous `await` inside the critical section. The concurrent
 * test below drives exactly that interleaving, so under the mutation the sum exceeds
 * the budget and it fails. The assertion is on the SUM rather than on any one verdict,
 * because every individual grant looks legal under the mutation and only the total does
 * not.
 */
import { describe, expect, test } from 'bun:test';
import { SwarmBudget } from '../src/strategy/swarm-budget';
import { BRANCH_REFUSAL_POLICIES } from '../src/strategy/swarm';
import type { BranchProposal, ResolvedSwarmCaps, SwarmConfig } from '../src/strategy/swarm';

function config(over?: Partial<SwarmConfig>): SwarmConfig {
  return {
    unit: { kind: 'answer' }, context: 'fork',
    expand: 'sample',
    score: { kind: 'verify' }, advance: { kind: 'uct' }, carry: { kind: 'none' },
    ...over,
  };
}

function caps(depth: number, branches: number): ResolvedSwarmCaps {
  return {
    depth: { value: depth, origin: 'call' },
    branches: { value: branches, origin: 'call' },
  };
}

function proposal(width: number): BranchProposal {
  return {
    rationale: 'this thread deserves its own budget',
    branches: Array.from({ length: width }, (_unused, i) => ({
      task: `sub-question ${String(i)}`, rationale: 'r', context: 'fork' as const,
    })),
  };
}

describe('the budget is the only thing that moves the budget', () => {
  test('an engine-driven expansion charges only what the budget can pay for', () => {
    const budget = new SwarmBudget(4);
    expect(budget.remaining).toBe(4);
    expect(budget.take(2)).toBe(2);
    expect(budget.remaining).toBe(2);
    // A wave wider than what remains runs NARROWER rather than creating children nothing
    // paid for. The `let childBudget` this replaced ran the full width and went negative,
    // which was sound only because the loop then stopped — and the loop no longer can,
    // since a granted level may still be owed after the budget empties.
    expect(budget.take(5)).toBe(2);
    expect(budget.remaining).toBe(0);
    expect(budget.take(3)).toBe(0);
    expect(budget.remaining).toBe(0);
  });

  test('a total of zero grants nothing, and a negative total is zero rather than debt', () => {
    expect(new SwarmBudget(0).remaining).toBe(0);
    expect(new SwarmBudget(-3).remaining).toBe(0);
  });

  test('an accepted proposal is DEBITED at arbitration, before the children exist', () => {
    // A grant that did not debit would let the same room be granted twice. The children
    // are created later — the engine expands them when selection reaches the node — so
    // the commitment has to be at the grant.
    const budget = new SwarmBudget(6);
    const decision = budget.arbitrate({
      config: config(), caps: caps(5, 3), atDepth: 1, proposal: proposal(3),
    });
    expect(decision.kind).toBe('granted');
    expect(budget.remaining).toBe(3);
    if (decision.kind !== 'granted') return;
    // The ids are minted with the debit, so the ids a node is told about are the ids the
    // engine writes rows for.
    expect(decision.nodeIds).toHaveLength(3);
    expect(new Set(decision.nodeIds).size).toBe(3);
    // And the grant carries the branches it paid for: an agent node's proposal exists
    // only inside the tool call that made it.
    expect(decision.proposal.branches).toHaveLength(3);
  });

  test('a refusal debits NOTHING — the five policies are free', () => {
    const budget = new SwarmBudget(4);
    const refused = budget.arbitrate({
      // At the cap: the children would be depth 2 against a cap of 1.
      config: config(), caps: caps(1, 3), atDepth: 1, proposal: proposal(2),
    });
    expect(refused).toMatchObject({ kind: 'refused', policy: 'depth-exhausted' });
    expect(budget.remaining).toBe(4);
  });

  test('the arbiter it wraps is unchanged: every policy is still reachable through it', () => {
    // Conservation is added and nothing else. If wrapping had changed which proposals
    // pass, the Lean port would no longer read against the shipped arbiter.
    const decisions = [
      new SwarmBudget(10).arbitrate({
        config: config({ advance: { kind: 'none' } }), caps: caps(1, 3), atDepth: 0, proposal: proposal(2),
      }),
      new SwarmBudget(10).arbitrate({
        config: config(), caps: caps(5, 3), atDepth: 1, proposal: proposal(9),
      }),
      new SwarmBudget(10).arbitrate({
        config: config(), caps: caps(1, 3), atDepth: 1, proposal: proposal(2),
      }),
      new SwarmBudget(1).arbitrate({
        config: config(), caps: caps(5, 3), atDepth: 3, proposal: proposal(2),
      }),
      new SwarmBudget(10).arbitrate({
        config: config({ context: 'fresh' }), caps: caps(5, 3), atDepth: 1, proposal: proposal(2),
      }),
    ];
    const reached = decisions.flatMap(
      (decision) => (decision.kind === 'refused' ? [decision.policy] : []),
    );
    expect(reached).toEqual([...BRANCH_REFUSAL_POLICIES]);
  });
});

describe('THE RACE: two nodes proposing at once cannot both be paid from one budget', () => {
  test('concurrent grants SUM to no more than the budget', async () => {
    // Three children of room, four nodes each asking for two. Exactly one can be paid.
    // The shape this replaced — read the number, await something, subtract — would grant
    // several, and each grant would look legal on its own because each saw 3 >= 2.
    const budget = new SwarmBudget(3);
    const ask = async (atDepth: number) => {
      // The await is the point: it puts a real suspension between the callers, which is
      // what a tool loop does. Conservation has to survive it.
      await Promise.resolve();
      return budget.arbitrate({
        config: config(), caps: caps(5, 3), atDepth, proposal: proposal(2),
      });
    };
    const decisions = await Promise.all([ask(1), ask(1), ask(1), ask(1)]);

    const granted = decisions.flatMap((decision) => (decision.kind === 'granted' ? [decision] : []));
    const total = granted.reduce((sum, decision) => sum + decision.width, 0);
    // THE INVARIANT, asserted on the sum rather than on the count.
    expect(total).toBeLessThanOrEqual(3);
    expect(budget.remaining).toBe(3 - total);
    // Sharpness: exactly one of four was paid, so this is not passing because the
    // arbiter refused everything.
    expect(granted).toHaveLength(1);
    // And every refusal names the budget rather than something else, so a node learns
    // why it was not paid.
    for (const decision of decisions) {
      if (decision.kind === 'granted') continue;
      expect(decision.policy).toBe('budget-exhausted');
      expect(decision.error).toContain('remain in this search');
    }
  });

  test('a hundred concurrent asks never overspend and never go negative', async () => {
    // The property rather than one interleaving: whatever order the microtasks resolve
    // in, what the budget gave up equals what was granted, and it never exceeds the
    // total.
    const total = 40;
    const budget = new SwarmBudget(total);
    const decisions = await Promise.all(
      Array.from({ length: 100 }, async (_unused, i) => {
        await Promise.resolve();
        return budget.arbitrate({
          config: config(), caps: caps(9, 3), atDepth: 1 + (i % 4), proposal: proposal(2 + (i % 3)),
        });
      }),
    );
    const spent = decisions.reduce(
      (sum, decision) => sum + (decision.kind === 'granted' ? decision.width : 0), 0,
    );
    expect(spent).toBeLessThanOrEqual(total);
    expect(budget.remaining).toBe(total - spent);
    expect(budget.remaining).toBeGreaterThanOrEqual(0);
    expect(budget.committed).toBe(spent);
  });

  test('the depth cap holds at arbitration as well as at selection', () => {
    // Two independent gates on one number, deliberately: selection excludes a node at
    // the cap with a WHERE clause, and arbitration refuses one from inside a node's own
    // tool call. A search whose only depth gate was selection would let an agent node
    // mint a level past the cap between waves.
    const budget = new SwarmBudget(100);
    for (let atDepth = 0; atDepth <= 6; atDepth += 1) {
      const decision = budget.arbitrate({
        config: config(), caps: caps(3, 3), atDepth, proposal: proposal(2),
      });
      if (atDepth < 3) {
        expect(decision.kind).toBe('granted');
      } else {
        expect(decision).toMatchObject({ kind: 'refused', policy: 'depth-exhausted' });
      }
    }
  });
});
