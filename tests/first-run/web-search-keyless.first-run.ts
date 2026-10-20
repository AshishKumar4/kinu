/**
 * FIRST RUN: a web search answers on the deployment's own gateway, for an account that never chose and holds no
 * Cloudflare login.
 *
 * THE ASK. The owner's search in earthen-plane-fb5ed18f (2026-10-17) failed with
 * `{"reason":"unavailable","error":"web search failed (522)"}`: an account with no search key searches through the
 * deployment's own provider, then a scraped engine, now Cloudflare's Web Search API (dafb2c6aa). This case acts as the
 * `keyless` eval account, the scripted model, the default chain and no Cloudflare login, so its search takes Exa on
 * the deployment's gateway, as a person's who never chose does, and the spend row names no account of theirs. Every
 * check reads durable state (`searched.ts`).
 */
import { afterAll, describe, test } from 'vitest';
import type { EvalObservation } from '@kinu.run/test-utils';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { searchSubgoals } from './searched';

const SUITE = 'First-run · web-search-keyless';

const CASE = firstRunCaseId(import.meta.url);

const DEFECT: FirstRunDefect = {
  found: 'The owner asked the agent to look up places in Raleigh and its search failed with '
    + '"web search failed (522)" (2026-10-17): with no search key, the deployment\'s own provider did not answer.',
  missedBecause: 'the only deployed search row gives its account a Tavily key pointed at the scripted search, so the '
    + 'provider a person with no key gets was never called on a deployment.',
  provedRedAt: null,
  redDirection: 'RED while Cloudflare\'s Web Search API answers the deployment 402: until the account has AI Gateway '
    + 'credits the tool says web search is not available on this deployment, and `searched` and `results-returned` '
    + 'are missed. Measured on staging 667f96316, 2026-10-19, through an account with no search key and a real model: '
    + 'the `web` search answered "Web search is not available on this deployment right now". The case itself first runs '
    + 'on the deploy that carries the `keyless` account.',
};

const PLAN = firstRunCasePlan(SUITE, 'keyless', 'keyless');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      defect: DEFECT,
      modelCalls: 'expected',
      budgetMs: 5 * 60_000,
      genesis: false,
      purpose: 'A terse assistant that uses the tool it is asked to use and reports the result in one line.',
      async run({ session }) {
        return await searchSubgoals(session, { provider: 'exa', payer: 'deployment' });
      },
    }, observations);
  });
});
