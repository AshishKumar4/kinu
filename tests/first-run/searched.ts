/**
 * What a first-run search case reads off durable state, never the model's own account of what it did: the run's
 * `tool_call_end` row and the stored reply (the search answered, it returned URLs, the reply names one of them, the
 * provider the account chose answered it), and the spend the person reads (who it billed). web-search runs it on a
 * chosen provider, web-search-keyless on the deployment's own gateway, web-search-own-gateway on the account's.
 *
 * Who paid is read off this case's own workspace, which made this one search: its Activity spend by account, where
 * the search's row is the only call on its payer. A search's `model_call` row is filed in main's isolate, which no public
 * route reads (staging rc23 and rc27, 2026-10-20). Never the account's Usage across the search: it sums the account's
 * live workspaces, which the cases beside this one create and delete (rc27, 2026-10-20: `openai-compat@main +-3`).
 */
import * as v from 'valibot';
import type { EvalSubgoal } from '@kinu.run/test-utils';
import { WEB_SEARCH_PROVIDERS, type AccountSpend, type JsonValue, type RunEvent, type WebSearchProviderId } from '../../packages/core/src/index';
import type { KinuPublicSession } from '../../evals/src/session';
import { SEARCH_ASK as ASK } from './asks';

type ToolCallEnd = Extract<RunEvent, { type: 'tool_call_end' }>;

function isToolCallEnd(event: RunEvent): event is ToolCallEnd {
  return event.type === 'tool_call_end';
}

const SearchArgsSchema = v.looseObject({ op: v.literal('search'), query: v.pipe(v.string(), v.minLength(1)) });

/** A result as the text a reader greps: a string as-is, anything else as JSON. */
function textOf(value: JsonValue | undefined): string {
  if (value === undefined) return '';
  const text = v.safeParse(v.string(), value);

  return text.success ? text.output : JSON.stringify(value);
}

/** The result URLs of one search, as the tool lays them out: each result's URL
 *  on its own line (`WEB.search.text`, packages/core/src/operations/web.ts). */
function resultUrls(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => {
    const url = URL.parse(line);

    return url !== null && (url.protocol === 'https:' || url.protocol === 'http:');
  });
}

/** Who pays for a search: the deployment's own gateway, or the account's (its `model_call` row's account). */
export type SearchPayer = 'deployment' | 'account';

/** The account a search on the person's own AI Gateway is filed under (`MY_GATEWAY_PROVIDER_ID`, `MAIN_ACCOUNT`). */
const OWN_GATEWAY = 'my-gateway@main';

/** The deployment's: a row naming no account of the person's. */
const NO_ACCOUNT = 'no account';

/** An account's row as Settings › Usage names it. */
const payerOf = (row: AccountSpend) => (row.provider === null ? NO_ACCOUNT : `${row.provider}@${row.account ?? ''}`);

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

  // This case's workspace is its own: its searches are the only calls on the payer, and the other payer holds none. The
  // model is the scripted one on its own account, never either payer.
  const spend = await session.spend();
  const filed = spend.producers.find((producer) => producer.source === 'search')?.calls ?? 0;
  const payer = expected.payer === 'account' ? OWN_GATEWAY : NO_ACCOUNT;
  const callsOn = (account: string) => spend.accounts.filter((row) => payerOf(row) === account).reduce((sum, row) => sum + row.calls, 0);
  const billed = filed > 0 && callsOn(payer) === filed && callsOn(payer === OWN_GATEWAY ? NO_ACCOUNT : OWN_GATEWAY) === 0;

  subgoals.push({
    what: 'billed',
    reached: billed,
    detail: `Activity counts ${String(filed)} web search(es); this workspace's calls by account: `
      + `${spend.accounts.map((row) => `${payerOf(row)} ${String(row.calls)}`).join(', ') || 'none'}; `
      + `this account's search bills ${payer === NO_ACCOUNT ? `${NO_ACCOUNT} (the deployment's gateway)` : payer}, and only it`,
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
