/**
 * Mission budget governor — the durable, label-scoped, transitive spend cap.
 *
 * Behaviour under test through the public surface only: declare/guard/debit/
 * snapshot and the governed `LLM` seam. The invariant that matters most is the
 * FIRST one: an actor that never declares a budget behaves exactly as before.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeExecRaw, makeSql } from './helpers.js';
import {
  MissionGovernor, MissionBudgetExhausted, readMissionLimits,
  type MissionBudgetRefusal,
} from '../src/mission-budget.js';
import { estimateUsdCost } from '../src/llm.js';
import type { LLM } from '../src/types/primitives.js';
import type { ModelPricing } from '../src/providers/types.js';

function makeGovernor(opts: {
  onExhausted?: (r: MissionBudgetRefusal) => void;
  pricing?: () => ModelPricing | null;
} = {}) {
  const db = new Database(':memory:');
  const storage = { sql: makeSql(db), execRaw: makeExecRaw(db) };
  const governor = new MissionGovernor({ storage, ...opts, now: () => 1_000 });
  return { governor, storage, db };
}

/** Claude Sonnet's published models.dev rates, USD per 1M tokens. */
const SONNET: ModelPricing = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

/** A scripted LLM whose completions are fixed-length, so the char estimate is
 *  deterministic. No network, no model. */
function scriptedLLM(reply: string, calls: string[] = []): LLM {
  return {
    // eslint-disable-next-line require-yield
    async *stream() { throw new Error('not used'); },
    async complete(prompt: string) { calls.push(prompt); return reply; },
  };
}

describe('mission budget — the uncapped default', () => {
  test('no declared label means no scope, no refusal, and no spend recorded', () => {
    const { governor } = makeGovernor();
    governor.activate(['never-declared']);
    expect(governor.scope).toEqual([]);
    expect(governor.guard('model_call')).toBeNull();
    expect(governor.guard('spawn')).toBeNull();
    governor.debit(1_000_000);
    expect(governor.snapshot()).toEqual([]);
  });

  test('a declared label with no limits meters but never refuses', () => {
    const { governor } = makeGovernor();
    governor.declare('mission', {});
    governor.activate(['mission']);
    governor.debit(5_000, { calls: 2 });
    const [row] = governor.snapshot();
    expect(row?.spent.tokens).toBe(5_000);
    expect(row?.calls).toBe(2);
    expect(row?.exhausted).toBe(false);
    expect(governor.guard('model_call')).toBeNull();
  });

  test('govern() returns the LLM untouched when nothing is active', async () => {
    const { governor } = makeGovernor();
    const llm = scriptedLLM('ok');
    expect(governor.govern(llm)).toBe(llm);
  });
});

describe('mission budget — caps and refusal', () => {
  test('a token cap refuses at the seam once spend reaches it', () => {
    const { governor } = makeGovernor();
    governor.declare('run', { tokens: 100 });
    governor.activate(['run']);
    governor.debit(99);
    expect(governor.guard('model_call')).toBeNull();
    governor.debit(1);
    const refusal = governor.guard('model_call');
    expect(refusal?.error).toBe('budget_exhausted');
    expect(refusal?.label).toBe('run');
    expect(refusal?.seam).toBe('model_call');
    expect(refusal?.spent.tokens).toBe(100);
    expect(refusal?.limit.tokens).toBe(100);
  });

  test('a USD cap converts through the same blended rate the rest of the system uses', () => {
    const { governor } = makeGovernor();
    const tokens = 20_000;
    governor.declare('run', { usd: estimateUsdCost(tokens) });
    governor.activate(['run']);
    governor.debit(tokens - 1);
    expect(governor.guard('spawn')).toBeNull();
    governor.debit(1);
    expect(governor.guard('spawn')?.seam).toBe('spawn');
  });

  test('exhaustion fires the run-event sink exactly once per label', () => {
    const seen: MissionBudgetRefusal[] = [];
    const { governor } = makeGovernor({ onExhausted: (r) => seen.push(r) });
    governor.declare('run', { tokens: 10 });
    governor.activate(['run']);
    governor.debit(10);
    governor.guard('model_call');
    governor.guard('spawn');
    governor.guard('model_call');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.label).toBe('run');
  });
});

describe('mission budget — transitive rollup', () => {
  test('a child debit charges every ancestor', () => {
    const { governor } = makeGovernor();
    governor.declare('mission', { tokens: 1_000 });
    governor.activate(['mission']);
    governor.declare('fork-a', { tokens: 100 });
    governor.debit(60, { labels: ['fork-a'] });

    expect(governor.snapshot('fork-a')[0]?.spent.tokens).toBe(60);
    expect(governor.snapshot('mission')[0]?.spent.tokens).toBe(60);
  });

  test('the outer cap stops a child that is still inside its own', () => {
    const { governor } = makeGovernor();
    governor.declare('mission', { tokens: 50 });
    governor.activate(['mission']);
    governor.declare('fork-a', { tokens: 10_000 });
    governor.debit(50, { labels: ['fork-a'] });

    const refusal = governor.guard('spawn', ['fork-a']);
    expect(refusal?.label).toBe('mission');
    expect(refusal?.scope).toBe('fork-a');
    expect(governor.snapshot('fork-a')[0]?.exhausted).toBe(false);
  });

  test('a re-declared label keeps accumulating instead of resetting', () => {
    const { governor } = makeGovernor();
    governor.declare('cron-nightly', { tokens: 100 });
    governor.activate(['cron-nightly']);
    governor.debit(80);
    governor.declare('cron-nightly', { tokens: 100 });
    expect(governor.snapshot('cron-nightly')[0]?.spent.tokens).toBe(80);
    expect(governor.snapshot('cron-nightly')[0]?.remaining.tokens).toBe(20);
  });

  test('the ledger survives a fresh governor over the same storage', () => {
    const { governor, storage } = makeGovernor();
    governor.declare('mission', { tokens: 100 });
    governor.activate(['mission']);
    governor.debit(100);

    const revived = new MissionGovernor({ storage });
    revived.activate(['mission']);
    expect(revived.scope).toEqual(['mission']);
    expect(revived.guard('model_call')?.label).toBe('mission');
  });

  test('a self-parenting or unknown parent is dropped rather than cycled', () => {
    const { governor } = makeGovernor();
    governor.declare('a', { tokens: 10 }, { parent: 'a' });
    governor.declare('b', { tokens: 10 }, { parent: 'nope' });
    expect(governor.snapshot('a')[0]?.parent).toBeNull();
    expect(governor.snapshot('b')[0]?.parent).toBeNull();
  });
});

describe('mission budget — the governed model-call seam', () => {
  test('a completion is metered against the active label', async () => {
    const { governor } = makeGovernor();
    governor.declare('mission', {});
    governor.activate(['mission']);
    const llm = governor.govern(scriptedLLM('r'.repeat(40)));
    await llm.complete('p'.repeat(40));

    const [row] = governor.snapshot();
    // (40 prompt + 40 response) chars / 4 chars-per-token.
    expect(row?.spent.tokens).toBe(20);
    expect(row?.calls).toBe(1);
  });

  test('an exhausted label declines the call before it is issued', async () => {
    const { governor } = makeGovernor();
    governor.declare('mission', { tokens: 5 });
    governor.activate(['mission']);
    const calls: string[] = [];
    const llm = governor.govern(scriptedLLM('r'.repeat(400), calls));

    await llm.complete('p'.repeat(400));
    expect(calls).toHaveLength(1);

    await expect(llm.complete('again')).rejects.toThrow(MissionBudgetExhausted);
    expect(calls).toHaveLength(1);
  });

  test('the thrown error carries the structured refusal', async () => {
    const { governor } = makeGovernor();
    governor.declare('mission', { tokens: 1 });
    governor.activate(['mission']);
    governor.debit(1);
    const llm = governor.govern(scriptedLLM('x'));
    const err = await llm.complete('x').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(MissionBudgetExhausted);
    expect((err as MissionBudgetExhausted).refusal.seam).toBe('model_call');
  });
});

describe('mission budget — USD at catalog prices', () => {
  test('a reported call is priced from the model catalog, cache reads discounted', () => {
    const { governor } = makeGovernor({ pricing: () => SONNET });
    governor.declare('mission', {});
    governor.activate(['mission']);
    // 10k input of which 8k came from the cache, 2k output.
    governor.debit(12_000, { calls: 1, usage: { input: 10_000, output: 2_000, cached: 8_000 } });

    const [row] = governor.snapshot();
    // (2k × $3 + 8k × $0.30 + 2k × $15) / 1M
    const expected = (2_000 * 3 + 8_000 * 0.3 + 2_000 * 15) / 1_000_000;
    expect(row!.spent.usd).toBeCloseTo(expected, 10);
    expect(row!.spent.tokens).toBe(12_000);
    expect(row!.pricing).toEqual({ blendedTokens: 0, source: 'catalog' });
    // The blended rate would have been wrong by more than 2x here.
    expect(row!.spent.usd).not.toBeCloseTo(estimateUsdCost(12_000), 4);
  });

  test('no cache-read rate published: cached input is charged at the input rate', () => {
    const { governor } = makeGovernor({ pricing: () => ({ input: 3, output: 15 }) });
    governor.declare('m', {});
    governor.activate(['m']);
    governor.debit(1_500, { usage: { input: 1_000, output: 500, cached: 900 } });
    expect(governor.snapshot()[0]!.spent.usd).toBeCloseTo((1_000 * 3 + 500 * 15) / 1_000_000, 10);
  });

  test('spend the catalog cannot price falls back to the blended rate AND says so', () => {
    const { governor } = makeGovernor({ pricing: () => SONNET });
    governor.declare('m', {});
    governor.activate(['m']);
    // A fork reporting one total across its sub-agents' models — no split.
    governor.debit(4_000, { spawns: 1 });

    const [row] = governor.snapshot();
    expect(row!.spent.usd).toBeCloseTo(estimateUsdCost(4_000), 10);
    expect(row!.pricing).toEqual({ blendedTokens: 4_000, source: 'blended' });
  });

  test('a catalog that has not landed yet blends, and the ledger reads mixed once it does', () => {
    let pricing: ModelPricing | null = null;
    const { governor } = makeGovernor({ pricing: () => pricing });
    governor.declare('m', {});
    governor.activate(['m']);
    governor.debit(1_000, { usage: { input: 800, output: 200 } });
    expect(governor.snapshot()[0]!.pricing).toEqual({ blendedTokens: 1_000, source: 'blended' });

    pricing = SONNET;
    governor.debit(1_000, { usage: { input: 800, output: 200 } });
    const [row] = governor.snapshot();
    expect(row!.pricing).toEqual({ blendedTokens: 1_000, source: 'mixed' });
    expect(row!.spent.usd).toBeCloseTo(
      estimateUsdCost(1_000) + (800 * 3 + 200 * 15) / 1_000_000, 10);
  });

  test('a USD cap now refuses on what the model actually costs', () => {
    // 200k output tokens on Sonnet is $3.00; the blended rate would have called
    // the same spend $0.60 and let the run continue.
    const { governor } = makeGovernor({ pricing: () => SONNET });
    governor.declare('expensive', { usd: 2 });
    governor.activate(['expensive']);
    expect(governor.guard('model_call')).toBeNull();

    governor.debit(200_000, { calls: 1, usage: { input: 0, output: 200_000 } });
    const refusal = governor.guard('model_call');
    expect(refusal?.error).toBe('budget_exhausted');
    expect(refusal?.spent.usd).toBeCloseTo(3, 10);
    // Catalog-priced spend is stated as a measurement, not an approximation.
    expect(refusal?.note).toContain('= $3.0000');
    expect(governor.snapshot()[0]!.remaining.usd).toBe(0);
  });

  test('a ledger written before pricing existed migrates as blended, not as unspent', () => {
    const db = new Database(':memory:');
    const storage = { sql: makeSql(db), execRaw: makeExecRaw(db) };
    // The pre-pricing table, verbatim.
    storage.execRaw(`CREATE TABLE mission_budget (
      label TEXT PRIMARY KEY, parent_label TEXT, limit_usd REAL, limit_tokens INTEGER,
      spent_tokens INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0,
      spawns INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, exhausted_at INTEGER)`);
    storage.execRaw(`INSERT INTO mission_budget
      (label, parent_label, limit_usd, limit_tokens, spent_tokens, calls, spawns, created_at, exhausted_at)
      VALUES ('legacy', NULL, 1.0, NULL, 400000, 12, 0, 1, NULL)`);

    const governor = new MissionGovernor({ storage, now: () => 1_000 });
    const [row] = governor.snapshot('legacy');
    expect(row!.spent.tokens).toBe(400_000);
    expect(row!.spent.usd).toBeCloseTo(estimateUsdCost(400_000), 10);
    expect(row!.pricing).toEqual({ blendedTokens: 400_000, source: 'blended' });
    // $1.20 blended against a $1 cap — still exhausted, as it was before.
    expect(row!.exhausted).toBe(true);
  });
});

describe('readMissionLimits', () => {
  test('reads positive numbers and rejects everything else', () => {
    expect(readMissionLimits({})).toBeNull();
    expect(readMissionLimits({ budget_usd: 0 })).toBeNull();
    expect(readMissionLimits({ budget_usd: -1, budget_tokens: 'x' })).toBeNull();
    expect(readMissionLimits({ budget_usd: 2.5 })).toEqual({ usd: 2.5 });
    expect(readMissionLimits({ budget_tokens: 10.9 })).toEqual({ tokens: 10 });
    expect(readMissionLimits({ budget_usd: 1, budget_tokens: 2 })).toEqual({ usd: 1, tokens: 2 });
  });
});
