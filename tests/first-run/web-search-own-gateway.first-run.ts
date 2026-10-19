/**
 * FIRST RUN: a web search of an account signed in to Cloudflare bills that account's own AI Gateway.
 *
 * THE ASK. The owner, 2026-10-19: "users can choose to simply have web search billed from their ai gateway via unified
 * billing (default)". This case acts as the `gateway` eval account, the scripted model, the default chain, and a
 * Cloudflare login that grants web search (scripts/scripted-model.ts `connectCloudflare`: staging offers no Cloudflare
 * sign-in, so the login is a Cloudflare API token with the Web Search API's documented permissions, stored as the row a
 * sign-in stores). Its search must reach Cloudflare's REST API on that account, not the deployment's binding: the
 * search's spend row names the account's gateway (`my-gateway`). Every check reads durable state (`searched.ts`).
 */
import { afterAll, describe, test } from 'vitest';
import type { EvalObservation } from '@kinu.run/test-utils';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { searchSubgoals } from './searched';

const SUITE = 'First-run · web-search-own-gateway';

const CASE = firstRunCaseId(import.meta.url);

const DEFECT: FirstRunDefect = {
  found: 'Every search was the deployment\'s: the AI binding on the deployment\'s gateway paid for every account\'s search, '
    + 'whatever Cloudflare account the person had signed in with.',
  missedBecause: 'search had one payer and no account-level choice, so no row asked whose gateway a search billed.',
  provedRedAt: null,
  redDirection: 'RED on a build before the search chain: the `gateway` account\'s search runs on the deployment\'s '
    + 'binding, its spend row names no account, and `billed` is missed. The case first runs on the deploy that carries '
    + 'the `gateway` account.',
};

const PLAN = firstRunCasePlan(SUITE, 'gateway', 'gateway');

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
        return await searchSubgoals(session, { provider: 'exa', payer: 'account' });
      },
    }, observations);
  });
});
