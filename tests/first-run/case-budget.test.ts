// A first-run case declares the budget its waits end on, or it never runs: on staging 7fecf0225 a case with none waited
// on a card that never rendered until the tier was killed for silence.
import { expect, test } from 'bun:test';
import { runFirstRunCase, type FirstRunCaseSpec, type FirstRunPlan, type FirstRunSession } from './first-run';

/** Whether a case's spec may leave its budget out. A spec type that allowed it would make this `true`, and the
 *  declaration below would not compile. */
type BudgetOptional = Record<string, never> extends Pick<FirstRunCaseSpec, 'budgetMs'> ? true : false;

const budgetOptional: BudgetOptional = false;

/** A plan that counts the workspaces it is asked for and opens none. */
function countingPlan(): FirstRunPlan<FirstRunSession> & { opened: number } {
  const plan = {
    opened: 0,
    open: async (): Promise<FirstRunSession> => {
      plan.opened += 1;
      throw new Error('a refused case must not open a workspace');
    },
  };

  return plan;
}

/** A case whose budget is `budgetMs`, which runs nothing. */
function budgeted(budgetMs: number): FirstRunCaseSpec<FirstRunSession, object> {
  return {
    id: 'budgetless',
    defect: { found: 'nothing', missedBecause: 'nothing', provedRedAt: null, redDirection: 'none' },
    purpose: 'A case that declares no budget.',
    modelCalls: 'none',
    budgetMs,
    run: async () => [],
  };
}

test('a case cannot leave its budget out of its spec', () => {
  expect(budgetOptional).toBe(false);
});

test('a budget of nothing is refused before any workspace is made, in words naming the case', async () => {
  for (const budgetMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const plan = countingPlan();

    await expect(runFirstRunCase(plan, budgeted(budgetMs), [])).rejects
      .toThrow('budgetless: a first-run case declares the budget its waits end on (budgetMs), and this one declares none');
    expect(plan.opened).toBe(0);
  }
});
