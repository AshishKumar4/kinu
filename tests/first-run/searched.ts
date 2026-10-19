/**
 * What a first-run search case reads off durable state, the ledger's `tool_call_end` and `model_call` rows and the
 * stored reply, never the model's own account of what it did: the search answered, it returned URLs, the reply names
 * one of them, and the provider the account chose answered it, billed to whom the account's chain says. web-search
 * runs it on a chosen provider, web-search-keyless on the deployment's own gateway, web-search-own-gateway on the
 * account's.
 */
import * as v from 'valibot';
import type { EvalSubgoal } from '@kinu.run/test-utils';
import { WEB_SEARCH_PROVIDERS, type JsonValue, type RunEvent, type WebSearchProviderId } from '../../packages/core/src/index';
import type { KinuPublicSession } from '../../evals/src/session';
import { SEARCH_ASK as ASK } from './asks';

type ToolCallEnd = Extract<RunEvent, { type: 'tool_call_end' }>;

function isToolCallEnd(event: RunEvent): event is ToolCallEnd {
  return event.type === 'tool_call_end';
}

function isModelCall(event: RunEvent): event is Extract<RunEvent, { type: 'model_call' }> {
  return event.type === 'model_call';
}

const SearchArgsSchema = v.looseObject({ op: v.literal('search'), query: v.pipe(v.string(), v.minLength(1)) });

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

/** Who pays for a search: the deployment's own gateway, or the account's (its `model_call` row's account). */
export type SearchPayer = 'deployment' | 'account';

/** Ask for one search and read what came of it: answered by `provider`, paid for by `payer`. */
export async function searchSubgoals(session: KinuPublicSession, expected: { readonly provider: WebSearchProviderId; readonly payer: SearchPayer }): Promise<EvalSubgoal[]> {
  const subgoals: EvalSubgoal[] = [];

  await session.prompt(ASK);

  const events = await session.runEvents();

  const searches = events.filter(isToolCallEnd)
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

  const { label } = WEB_SEARCH_PROVIDERS[expected.provider];
  const named = textOf(answeredSearch?.result).includes(`results via ${label}]`);

  subgoals.push({
    what: 'chosen-provider',
    reached: named,
    detail: named
      ? `the search was answered by ${label}, the provider the account's chain names first`
      : `the search did not come from ${label}: ${textOf(answeredSearch?.result).slice(-120)}`,
  });

  const paidBy = events.filter(isModelCall)
    .filter((event) => event.source === 'search' && event.modelId === `websearch/${expected.provider}`)
    .map((event) => (event.account === undefined ? 'deployment' : `${event.account.provider}@${event.account.name}`));

  const wanted = expected.payer === 'deployment' ? 'deployment' : 'my-gateway@main';

  subgoals.push({
    what: 'billed',
    reached: paidBy.includes(wanted),
    detail: paidBy.length > 0
      ? `the search's spend row names ${paidBy.join(', ')}; this account's search bills ${wanted}`
      : `no search spend row for websearch/${expected.provider} in the run's ledger`,
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
}
