/**
 * FIRST RUN: a web search answers on the deployed product.
 *
 * THE ASK. An end-to-end pass of the keyed web search path: the deployed agent
 * searches with its `web` tool through the account's `tavily` credential, which
 * points at the tiers' scripted search (scripts/scripted-search.ts), and uses
 * what came back. From a Worker, key-less DuckDuckGo answered 522 or its bot
 * page on every staging run of 2026-09-27, which measured the provider, not the
 * product; whether a real provider answers is the evals' question. Every
 * check reads durable state — the ledger's `tool_call_end` row and the stored
 * reply — never the model's own account of what it did.
 *
 * WHY `every-tool` DOES NOT COVER IT. Its web call is a fetch of the product's
 * own health route. Search is the other action, and its provider (Tavily with
 * a key, Cloudflare's Web Search API without, packages/core/src/web/provider.ts)
 * is reached by no other row.
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
  redDirection: 'RED on the deployed build: DuckDuckGo answers the Worker 522 or rate-limits it, so every '
    + 'search fails; it stays red until the search provider serves Worker egress. Also planted on '
    + 'loopback `vite dev`: an endpoint that does not answer leaves `searched` and `results-returned` missed.',
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
      async run({ session }) {
        return await searchSubgoals(session);
      },
    }, observations);
  });
});

/** The defect this case is red on, re-exported so `wiring.test.ts` can hold the
 *  corpus and the defect register equal without importing the case modules. */
