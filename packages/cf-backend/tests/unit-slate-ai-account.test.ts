// Every model call is priced at the rate its account's catalog gives the very model it called (`pricedModelCallEvent`):
// the workspace's turn, its owner's slate AI on another tier, and a collaborator's own AI in someone else's slate alike.
// A collaborator's call is kept as one call's tally and counted with their workspaces (unit-account-usage-routes).
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { accountSpendOfCall, initUserTables, mergeAccountSpend, ModelCatalogSession, pricedModelCallEvent, type ModelInfo, type ModelPricing } from '@kinu.run/core';
import { addSlateAiSpend, slateAiSpendOf } from '../src/user/slate-ai-account';
import { durableSqlStorage } from './helpers/programmatic-host';

const TURN = 'anthropic@work/sonnet';

const OTHER = 'anthropic@work/haiku';

function catalog(models: Readonly<Record<string, ModelInfo>>): ModelCatalogSession {
  return new ModelCatalogSession({ effectiveSpec: () => TURN, lookup: async (spec) => models[spec] ?? null, measured: () => null });
}

describe('a model call is priced at its own model\'s rate, wherever it was made', () => {
  test('the turn\'s model, and another once warmed: each at its own rate', async () => {
    const prices = catalog({ [TURN]: { id: 'sonnet', cost: { input: 3, output: 15 } }, [OTHER]: { id: 'haiku', cost: { input: 1, output: 5 } } });
    const usage = { input: 1_000_000, output: 100_000 };

    // The turn's own model is looked up as the turn starts; another is warmed for the call that names it.
    await prices.resolved();
    await prices.warm([OTHER]);

    expect(pricedModelCallEvent({ source: 'slate', usage, spec: TURN }, prices).usd).toBeCloseTo(3 + 1.5);
    expect(pricedModelCallEvent({ source: 'slate', usage, spec: OTHER }, prices).usd).toBeCloseTo(1 + 0.5);
  });

  test('a model its catalog prices nothing for, or never warmed, is unpriced, never free', async () => {
    const prices = catalog({ [OTHER]: { id: 'haiku' } });

    await prices.warm([OTHER]);

    for (const spec of [OTHER, 'openai@main/never-warmed']) {
      const spend = accountSpendOfCall(pricedModelCallEvent({ source: 'slate', usage: { input: 10 }, spec }, prices));

      expect(spend).toMatchObject({ unpricedCalls: 1 });
      expect(spend).not.toHaveProperty('usd');
    }
  });
});

describe('a collaborator\'s room AI spend is a tally per provider account, as a workspace ledger sums it', () => {
  test('each call adds to its account\'s row; the read is one row per account, and equals the merge of the calls', () => {
    const database = new Database(':memory:');
    initUserTables(durableSqlStorage(database));
    const sql = durableSqlStorage(database);
    const work = { provider: 'anthropic', name: 'work' };

    const calls = [
      pricedModelCallEvent({ source: 'slate', usage: { input: 1_000, output: 100, cacheRead: 40 }, spec: TURN, account: work }, catalogOf({ cost: { input: 3, output: 15 } })),
      pricedModelCallEvent({ source: 'slate', usage: { input: 500 }, spec: TURN, account: work }, catalogOf(null)),
      pricedModelCallEvent({ source: 'slate', usage: {}, spec: TURN, account: work }, catalogOf(null)),
      pricedModelCallEvent({ source: 'slate', usage: { input: 7, neurons: 0.5 }, spec: 'workers-ai/x' }, catalogOf(null)),
    ].map(accountSpendOfCall);

    for (const call of calls) addSlateAiSpend(sql, call);

    expect(database.query('SELECT COUNT(*) AS n FROM slate_ai_spend').get()).toEqual({ n: 2 });
    expect(mergeAccountSpend([slateAiSpendOf(sql)])).toEqual(mergeAccountSpend(calls.map((call) => [call])));
  });
});

/** What a catalog that already knows the model prices it at: `rate`, or nothing. */
interface KnownRate {
  pricing(spec?: string): ModelPricing | null;
}

function catalogOf(info: { readonly cost?: ModelPricing } | null): KnownRate {
  return { pricing: () => info?.cost ?? null };
}
