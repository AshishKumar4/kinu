/**
 * What a first-run search case reads off durable state, never the model's own account of what it did: the run's
 * `tool_call_end` row and the stored reply (the search answered, it returned URLs, the reply names one of them, the
 * provider the account chose answered it), and the spend the person reads (who it billed). web-search runs it on a
 * chosen provider, web-search-keyless on the deployment's own gateway, web-search-own-gateway on the account's.
 *
 * Who paid is read where the product files it. The `web` tool runs in the workspace's own object, so a search's
 * `model_call` row is in the workspace's ledger, not the run's in main's isolate (staging rc23, 2026-10-20: the run's
 * events held none, while Activity counted the search and Usage named its account): the workspace's Activity says the
 * search was filed, and the account's Usage says whose account it went on.
 */
import * as v from 'valibot';
import type { EvalSubgoal } from '@kinu.run/test-utils';
import { WEB_SEARCH_PROVIDERS, type JsonValue, type RunEvent, type WebSearchProviderId } from '../../packages/core/src/index';
import type { KinuPublicSession, PublicSessionPlan } from '../../evals/src/session';
import { webHeaders } from '../../evals/src/workspace-roster';
import { AccountUsageSchema } from '../../packages/core/src/read-models/account-usage';
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
 *  on its own line (`formatSearchResults`, packages/core/src/tools/builtins.ts). */
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

/** Each account's calls as Settings › Usage reads them (`GET /api/user/usage`), across the account's live workspaces. */
async function usageCalls(plan: PublicSessionPlan): Promise<ReadonlyMap<string, number>> {
  const answer = await fetch(`${plan.origin}/api/user/usage`, { headers: webHeaders(plan.identity) });

  if (!answer.ok) throw new Error(`GET /api/user/usage answered ${String(answer.status)}: ${(await answer.text()).slice(0, 200)}`);
  const { accounts } = v.parse(AccountUsageSchema, await answer.json());

  return new Map(accounts.map((row) => [row.provider === null ? NO_ACCOUNT : `${row.provider}@${row.account ?? ''}`, row.calls]));
}

/** Ask for one search and read what came of it: answered by `provider`, paid for by `payer`. */
export async function searchSubgoals(session: KinuPublicSession, plan: PublicSessionPlan, expected: { readonly provider: WebSearchProviderId; readonly payer: SearchPayer }): Promise<EvalSubgoal[]> {
  const subgoals: EvalSubgoal[] = [];
  const before = await usageCalls(plan);

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

  const filed = (await session.spend()).producers.find((producer) => producer.source === 'search')?.calls ?? 0;
  const after = await usageCalls(plan);
  const grew = (account: string) => (after.get(account) ?? 0) - (before.get(account) ?? 0);
  const ownGateway = grew(OWN_GATEWAY);
  // The account's model is the scripted one, never its gateway: only a search goes on `my-gateway`.
  const billed = filed > 0 && (expected.payer === 'account' ? ownGateway >= filed : ownGateway === 0 && grew(NO_ACCOUNT) >= filed);
  const moved = [...after.keys()].filter((account) => grew(account) !== 0).map((account) => `${account} +${String(grew(account))}`);

  subgoals.push({
    what: 'billed',
    reached: billed,
    detail: `Activity counts ${String(filed)} web search(es); across the search, Usage moved ${moved.join(', ') || 'nothing'}; `
      + `this account's search bills ${expected.payer === 'account' ? OWN_GATEWAY : `${NO_ACCOUNT} (the deployment's gateway), and ${OWN_GATEWAY} stays as it was`}`,
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
