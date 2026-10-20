/**
 * FIRST RUN: a web search answers on the deployed product, from the provider the account chose.
 *
 * THE ASK. An end-to-end pass of the web search capability, and of the choice the owner asked for on 2026-10-19:
 * search billed through Cloudflare by default, or a provider a person picks. The `scripted` account's chain names
 * Linkup (scripts/scripted-model.ts `chooseSearch`), not the default Exa, so the deployed agent's `web` search must
 * come from the provider the account's catalog names, through the deployment's gateway. Every check reads durable
 * state — the ledger's `tool_call_end` and `model_call` rows and the stored reply — never the model's own account of
 * what it did.
 *
 * WHY `every-tool` DOES NOT COVER IT. Its web call is a fetch of the product's own health route. Search is the other
 * action, and its chain (packages/core/src/web/search-chain.ts) is reached by no other row.
 */
import { afterAll, describe, test } from 'vitest';
import type { EvalObservation } from '@kinu.run/test-utils';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { searchSubgoals } from './searched';

const SUITE = 'First-run · web-search';

const CASE = firstRunCaseId(import.meta.url);

/** What this case found, and what a red here means (`FirstRunDefect`). */
const DEFECT: FirstRunDefect = {
  found: 'The owner asked for an end-to-end pass of the web search capability, and no deployed row '
    + 'ever asked the agent to search: `every-tool` fetches the product\'s own health route.',
  missedBecause: 'the search provider (Tavily with a key, then DuckDuckGo without) was unit-tested over '
    + 'fixture pages, so a provider the deployment cannot reach, or a layout it no longer parses, '
    + 'is invisible until a user asks the agent to look something up.',
  provedRedAt: 'b220f59f8',
  redDirection: 'RED on the deployed build: DuckDuckGo answered the Worker 522 or rate-limited it, so every '
    + 'search failed. Since the search chain, also RED on a build that does not read the account\'s choice: the search '
    + 'comes from Exa, not Linkup, and `chosen-provider` is missed.',
};

const PLAN = firstRunCasePlan(SUITE, 'search');

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
      async run({ session, plan }) {
        return await searchSubgoals(session, plan, { provider: 'linkup', payer: 'deployment' });
      },
    }, observations);
  });
});
