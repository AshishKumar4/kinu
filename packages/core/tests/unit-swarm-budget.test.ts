/**
 * Budget conservation: an arbiter's grants to a node's children sum to no more than the
 * parent's remaining budget. Agent nodes propose concurrently, so a read-await-debit
 * refactor of `arbitrate` would overspend while every individual grant looks legal; the
 * concurrent tests assert on the sum.
 * Specified by docs/EXPLORATION.md — "Budget conservation".
 */
import { describe, expect, test } from 'bun:test';
import { SwarmBudget } from '../src/strategy/swarm-budget';
import { BRANCH_REFUSAL_POLICIES } from '../src/strategy/swarm';
import type { BranchProposal, ResolvedSwarmCaps, SwarmConfig } from '../src/strategy/swarm';

function config(over?: Partial<SwarmConfig>): SwarmConfig {
  return {
    unit: { kind: 'answer' }, context: 'inherit',
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
      task: `sub-question ${String(i)}`, rationale: 'r', context: 'inherit' as const,
    })),
  };
}

describe('the budget is the only thing that moves the budget', () => {
  test('an engine-driven expansion charges only what the budget can pay for', () => {
    const budget = new SwarmBudget(4);
    expect(budget.remaining).toBe(4);
    expect(budget.take(2)).toBe(2);
    expect(budget.remaining).toBe(2);
    // A wave wider than what remains runs narrower rather than creating unpaid children.
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
    // Children are created later, so the commitment must be at the grant or room is granted twice.
    const budget = new SwarmBudget(6);

    const decision = budget.arbitrate({
      config: config(), caps: caps(5, 3), atDepth: 1, proposal: proposal(3),
    });

    expect(decision.kind).toBe('granted');
    expect(budget.remaining).toBe(3);

    if (decision.kind !== 'granted') return;
    // Ids are minted with the debit, so the node is told the ids the engine writes.
    expect(decision.nodeIds).toHaveLength(3);
    expect(new Set(decision.nodeIds).size).toBe(3);
    // An agent node's proposal exists only inside the tool call that made it.
    expect(decision.proposal.branches).toHaveLength(3);
  });

  test('a refusal debits NOTHING — the five policies are free', () => {
    const budget = new SwarmBudget(4);

    const refused = budget.arbitrate({
      config: config(), caps: caps(1, 3), atDepth: 1, proposal: proposal(2),
    });

    expect(refused).toMatchObject({ kind: 'refused', policy: 'depth-exhausted' });
    expect(budget.remaining).toBe(4);
  });

  test('the arbiter it wraps is unchanged: every policy is still reachable through it', () => {
    // Wrapping must not change which proposals pass, or the Lean port no longer matches.
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
    // Three children of room, four asks of two: exactly one can be paid.
    const budget = new SwarmBudget(3);

    const ask = async (atDepth: number) => {
      // A real suspension between callers, as a tool loop has.
      await Promise.resolve();

      return budget.arbitrate({
        config: config(), caps: caps(5, 3), atDepth, proposal: proposal(2),
      });
    };

    const decisions = await Promise.all([ask(1), ask(1), ask(1), ask(1)]);

    const granted = decisions.flatMap((decision) => (decision.kind === 'granted' ? [decision] : []));
    const total = granted.reduce((sum, decision) => sum + decision.width, 0);
    expect(total).toBeLessThanOrEqual(3);
    expect(budget.remaining).toBe(3 - total);
    // Sharpness: not passing because everything was refused.
    expect(granted).toHaveLength(1);

    for (const decision of decisions) {
      if (decision.kind === 'granted') continue;
      expect(decision.policy).toBe('budget-exhausted');
      expect(decision.error).toContain('remain in this search');
    }
  });

  test('a hundred concurrent asks never overspend and never go negative', async () => {
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
    // Selection alone would let an agent node mint a level past the cap between waves.
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
