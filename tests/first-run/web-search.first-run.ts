/**
 * FIRST RUN: a live web search answers on the deployed product.
 *
 * THE ASK. An end-to-end pass of the web search capability: the deployed agent
 * searches the live web with its `web` tool and uses what came back. Every
 * check reads durable state — the ledger's `tool_call_end` row and the stored
 * reply — never the model's own account of what it did.
 *
 * WHY `every-tool` DOES NOT COVER IT. Its web call is a fetch of the product's
 * own health route. Search is the other action, and its provider (Tavily with
 * a key, DuckDuckGo without, packages/core/src/web/provider.ts) is reached by
 * no other row.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import type { JsonValue, RunEvent } from '../../packages/core/src/index';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';
import { SEARCH_ASK as ASK } from './asks';

const SUITE = 'First-run · web-search';

const CASE = 'web-search' as const;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

type ToolCallEnd = Extract<RunEvent, { type: 'tool_call_end' }>;

function isToolCallEnd(event: RunEvent): event is ToolCallEnd {
  return event.type === 'tool_call_end';
}

const SearchArgsSchema = v.looseObject({ action: v.literal('search'), query: v.pipe(v.string(), v.minLength(1)) });

/** A result as the text a reader greps: a string as-is, anything else as JSON. */
function textOf(value: JsonValue | undefined): string {
  if (value === undefined) return '';
  const text = v.safeParse(v.string(), value);

  return text.success ? text.output : JSON.stringify(value);
}

/** The result URLs of one search, as the tool lays them out: each result's URL
 *  on its own line (`formatSearchResults`, packages/core/src/tools/builtins.ts). */
function resultUrls(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => {
    const url = URL.parse(line);

    return url !== null && (url.protocol === 'https:' || url.protocol === 'http:');
  });
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      modelCalls: 'expected',
      genesis: false,
      purpose: 'A terse assistant that uses the tool it is asked to use and reports the result in one line.',
      async run({ session }) {
        const subgoals: EvalSubgoal[] = [];

        await session.prompt(ASK);

        const searches = (await session.runEvents()).filter(isToolCallEnd)
          .filter((call) => call.name === 'web' && v.safeParse(SearchArgsSchema, call.args).success);

        const answeredSearch = searches.find((call) => call.error === undefined && call.outcome?.success !== false);

        subgoals.push({
          what: 'searched',
          reached: answeredSearch !== undefined,
          detail: answeredSearch !== undefined
            ? `web search #${answeredSearch.toolCallId} answered for ${JSON.stringify(answeredSearch.args)}`
            : `${String(searches.length)} web search call(s), none answered: `
              + searches.map((call) => `${call.toolCallId} ${JSON.stringify(call.error ?? call.outcome ?? null).slice(0, 160)}`).join('; '),
        });

        const results = resultUrls(textOf(answeredSearch?.result));

        subgoals.push({
          what: 'results-returned',
          reached: results.length > 0,
          detail: results.length > 0
            ? `the search returned ${String(results.length)} URL(s), first ${results[0] ?? ''}`
            : `the search result carried no URL: ${textOf(answeredSearch?.result).slice(0, 200)}`,
        });

        const reply = (await session.history()).filter((row) => row.role === 'assistant').at(-1)?.text ?? '';
        const cited = results.filter((url) => reply.includes(url));

        subgoals.push({
          what: 'result-used',
          reached: cited.length > 0,
          detail: cited.length > 0
            ? `the reply names ${cited[0] ?? ''}, a URL the search returned`
            : `the reply names no URL the search returned: ${JSON.stringify(reply.slice(0, 200))}`,
        });

        return subgoals;
      },
    }, observations);
  });
});

/** The defect this case is red on, re-exported so `wiring.test.ts` can hold the
 *  corpus and the defect register equal without importing the case modules. */
export const DEFECT = FIRST_RUN_DEFECTS[CASE];
