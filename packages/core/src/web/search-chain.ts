/**
 * A search as the account chose it: its chain of providers (`webSearch` in the profile catalog), each billed through
 * Cloudflare or to the person's own key. A refusal hands over at once to the next entry and parks the refused one, for
 * whoever pays for it, until its Retry-After; the last entry is asked again up to the account's `retries` after a failure
 * that may pass. What the person reads when every entry refused is each provider's own words (AGENTS.md, Owner
 * Preferences).
 */
import { Effect } from 'effect';
import * as v from 'valibot';
import {
  CLOUDFLARE_WEB_SEARCH, WEB_SEARCH_PROVIDERS,
  type SearchAnswer, type WebSearchProviderId, type WebSearchRoute,
} from '../providers/web-search';
import { CLOUDFLARE_WEB_SEARCH_CRED_KEY, cloudflareAccountAPIRoot } from '../providers/cloudflare-oauth';
import { authenticatedSend } from '../providers/authenticated-send';
import { retryAfterOf } from '../providers/fallback-cooldown';
import { backoffCeiling, MAX_RETRY_DELAY_MS } from '../providers/middleware/retry';
import { providerPacer, type ProviderPacer } from '../providers/pacing';
import { codeForStatus } from '../providers/util';
import { parseGatewayTarget } from '../providers/gateway-binding-fetch';
import { workersAiWebSearch, type WorkersAiWebSearch } from '../providers/model-invocation';
import { MY_GATEWAY_PROVIDER_ID } from '../providers/my-gateway';
import type { AuthResolution, AuthResolver } from '../providers/types';
import type { CallAccount } from '../providers/quota';
import { accountOf, MAIN_ACCOUNT } from '../credentials/accounts';
import type { ModelCallSink } from '../events/model-call';
import { sha256Hex } from '../safety/argument-digest';
import { attemptInItsWords, KinuError, settle } from '../obs/index';
import { isSafeUrl } from './url-safety';
import { stripBase64Images } from './markdown';
import type { WebSearchResponse, WebSearchResult } from './provider';

/** One search, as the `web` tool asks it. */
export type WebSearch = (input: { readonly query: string; readonly limit: number; readonly signal?: AbortSignal }) => Promise<WebSearchResponse>;

export interface WebSearchChain {
  readonly routes: readonly WebSearchRoute[];
  /** How many more times the last entry is asked after a failure that may pass. */
  readonly retries: number;
}

/** The deployment's own Cloudflare search: the AI binding on the gateway `AI_GATEWAY_URL` names. */
export type DeploymentSearch = (request: { readonly query: string; readonly limit: number; readonly provider: WebSearchProviderId }) => Promise<Response>;

interface WebSearchDeps {
  readonly fetch: typeof fetch;
  /** The account's keys, stored under each provider's id, and its Cloudflare login as {@link CLOUDFLARE_WEB_SEARCH_CRED_KEY}. */
  readonly getAuth: AuthResolver;
  /** Absent off a Worker: a CLI signed out has no deployment to bill. */
  readonly deployment?: DeploymentSearch;
  /** Each answered search files one `search` row naming the provider and, where it is not the deployment, who paid. */
  readonly report: ModelCallSink;
  readonly chain: () => Promise<WebSearchChain>;
  readonly pacer?: ProviderPacer;
}

/** What a result's snippet keeps: the clip Tavily snippets had. Cloudflare's descriptions run to 8,000 characters. */
const SNIPPET_CHARS = 600;

interface Refused {
  readonly kind: 'refused';
  /** The entry, then the provider's own words. */
  readonly said: string;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  /** Asking the same entry again may pass: a rate limit, an outage, a dropped connection. */
  readonly passing: boolean;
}

type Attempt = { readonly kind: 'answered'; readonly response: WebSearchResponse } | Refused;

/** An entry with someone to pay for it, ready to send. */
interface Payer {
  readonly kind: 'payer';
  /** Where a refusal parks it: the provider and who pays, never the secret. */
  readonly lane: string;
  /** The entry as the person reads it, naming who pays. */
  readonly entry: string;
  /** Who refuses in its own words: Cloudflare for its API, else the provider. */
  readonly speaker: string;
  readonly answer: v.GenericSchema<unknown, SearchAnswer>;
  readonly refusal: v.GenericSchema<unknown, string>;
  readonly account: CallAccount | undefined;
  /** Null: the login it was resolved with is gone. */
  send(signal: AbortSignal | undefined): Promise<Response | null>;
}

function refused(said: string, input: { readonly status?: number; readonly retryAfterMs?: number | null; readonly passing: boolean }): Refused {
  return { kind: 'refused', said, status: input.status ?? null, retryAfterMs: input.retryAfterMs ?? null, passing: input.passing };
}

export function chainWebSearch(deps: WebSearchDeps): WebSearch {
  const pacer = deps.pacer ?? providerPacer;
  // Detached: workerd's fetch throws "Illegal invocation" when called as `deps.fetch`.
  const fetchImpl = deps.fetch;

  /** Who pays for `route`, or why nobody can: an entry with nobody to pay for it is passed over, never parked. */
  const payerOf = (route: WebSearchRoute, query: string, limit: number): Effect.Effect<Payer | Refused, KinuError> => Effect.gen(function* () {
    const { label, direct } = WEB_SEARCH_PROVIDERS[route.provider];

    if (route.billing === 'key') {
      const entry = `${label} with your key`;

      if (direct === null) return refused(`${entry}: ${label} is searched only through Cloudflare`, { passing: false });
      const auth = yield* attemptInItsWords('unavailable', () => deps.getAuth(route.provider));
      const key = /^Bearer (.+)$/i.exec(new Headers(auth?.headers).get('authorization') ?? '')?.[1];

      if (auth === null || key === undefined) return refused(`${entry}: no ${label} key is stored`, { passing: false });
      const request = direct.request({ query, limit: Math.min(limit, direct.maxResults), key });

      return {
        kind: 'payer', lane: `websearch|${route.provider}|key:${sha256Hex(key).slice(0, 16)}`, entry, speaker: label,
        answer: direct.answer, refusal: direct.refusal, account: { provider: route.provider, name: accountOf(auth.credentialKey ?? route.provider) },
        send: (signal) => fetchImpl(request.url, { ...request.init, signal }),
      } satisfies Payer;
    }

    const asked = { query, limit: Math.min(limit, CLOUDFLARE_WEB_SEARCH.maxResults), provider: route.provider };
    const login = yield* attemptInItsWords('unavailable', () => deps.getAuth(CLOUDFLARE_WEB_SEARCH_CRED_KEY));
    const common = { kind: 'payer', speaker: 'Cloudflare', answer: CLOUDFLARE_WEB_SEARCH.answer, refusal: CLOUDFLARE_WEB_SEARCH.refusal } as const;

    if (login !== null) {
      const entry = `${label} on your AI Gateway`;
      const root = cloudflareAccountAPIRoot(login.baseURL ?? '');
      const gateway = login.headers['cf-aig-gateway-id'];

      if (root === null) return refused(`${entry}: your Cloudflare login names no account`, { passing: false });

      const sign = (signal: AbortSignal | undefined) => (auth: AuthResolution) => fetchImpl(`${root}/ai/websearch/`, {
        method: 'POST',
        headers: { authorization: new Headers(auth.headers).get('authorization') ?? '', 'content-type': 'application/json' },
        body: JSON.stringify({ ...asked, options: { gateway: { id: auth.headers['cf-aig-gateway-id'] } } }),
        signal,
      });

      return {
        ...common, lane: `websearch|${route.provider}|${root}|${gateway ?? ''}`, entry, account: { provider: MY_GATEWAY_PROVIDER_ID, name: MAIN_ACCOUNT },
        // One renewal of the login on a 401, as every Cloudflare call makes.
        send: async (signal) => {
          const said = await authenticatedSend({ key: CLOUDFLARE_WEB_SEARCH_CRED_KEY, getAuth: deps.getAuth, auth: login, send: sign(signal) });

          return said.kind === 'absent' ? null : said.response;
        },
      } satisfies Payer;
    }

    const deployment = deps.deployment;

    if (deployment === undefined) return refused(`${label} through Cloudflare: no Cloudflare account is connected, and nothing here has a gateway of its own`, { passing: false });

    return {
      ...common, lane: `websearch|${route.provider}|deployment`, entry: `${label} on this deployment's AI Gateway`, account: undefined,
      send: () => deployment(asked),
    } satisfies Payer;
  });

  const ask = (route: WebSearchRoute, payer: Payer, asked: { readonly query: string; readonly limit: number; readonly signal: AbortSignal | undefined }): Effect.Effect<Attempt, KinuError> => Effect.gen(function* () {
    const { query, limit, signal } = asked;

    const sent = yield* attemptInItsWords('unavailable', () => payer.send(signal)).pipe(
      // Cancellation ends the search; anything else that kept the request from its provider is this entry's refusal.
      Effect.catch((failed) => (signal?.aborted === true || failed.code === 'cancelled'
        ? Effect.fail(failed)
        : Effect.succeed(refused(`${payer.entry}: ${failed.message}`, { passing: true })))),
    );

    if (sent === null) return refused(`${payer.entry}: your Cloudflare login is gone`, { passing: false });

    if (!(sent instanceof Response)) return sent;
    const body = yield* attemptInItsWords('io', () => sent.text());

    if (!sent.ok) {
      const words = v.safeParse(v.pipe(v.string(), v.parseJson(), payer.refusal), body);

      return refused(`${payer.entry}: ${payer.speaker} answered ${sent.status}: ${words.success ? words.output : body.slice(0, 200)}`, {
        status: sent.status,
        retryAfterMs: retryAfterOf(sent.headers, Date.now()),
        passing: sent.status === 408 || sent.status === 429 || sent.status >= 500,
      });
    }

    const answered = v.safeParse(v.pipe(v.string(), v.parseJson(), payer.answer), body);

    if (!answered.success) return refused(`${payer.entry}: ${payer.speaker} answered in a shape Kinu does not read: ${body.slice(0, 200)}`, { passing: false });

    const results = answered.output.hits.filter((hit) => isSafeUrl(hit.url)).slice(0, limit).map((hit, at): WebSearchResult => {
      const title = hit.title?.trim();
      const date = hit.date?.trim();

      return {
        title: title === undefined || title === '' ? hit.url : title,
        url: hit.url,
        snippet: stripBase64Images((hit.snippet ?? '').trim()).slice(0, SNIPPET_CHARS),
        ...(date !== undefined && date !== '' && { date }),
        position: at + 1,
      };
    });

    deps.report({ source: 'search', usage: {}, modelId: `websearch/${route.provider}`, account: payer.account });
    const answer = answered.output.answer?.trim();

    return { kind: 'answered', response: { query, results, source: route.provider, ...(answer !== undefined && answer !== '' && { answer }) } };
  });

  return ({ query, limit, signal }) => settle(Effect.gen(function* () {
    const { routes, retries } = yield* attemptInItsWords('unavailable', deps.chain);
    const said: string[] = [];

    const exhausted = (last: Refused) => new KinuError(
      (last.status === null ? null : codeForStatus(last.status)) ?? 'unavailable',
      [...said, last.said].join('; '),
    );

    for (const [at, route] of routes.entries()) {
      const final = at === routes.length - 1;
      const payer = yield* payerOf(route, query, limit);

      if (payer.kind === 'refused') {
        if (final) return yield* Effect.fail(exhausted(payer));
        said.push(payer.said);

        continue;
      }

      if (!final && pacer.parked(payer.lane)) continue;

      for (let tries = 0; ; tries++) {
        const outcome = yield* ask(route, payer, { query, limit, signal });

        if (outcome.kind === 'answered') return outcome.response;
        pacer.park(payer.lane, outcome.retryAfterMs);

        // Every refusal hands over, a 400 too: a one-line query is rarely what a provider refuses. Cloudflare answers 400
        // to a gateway the account lacks (2026-10-19), and another entry may be paid for elsewhere.
        if (!final) {
          said.push(outcome.said);

          break;
        }

        const waitMs = outcome.retryAfterMs ?? Math.floor(Math.random() * backoffCeiling(tries + 1));

        if (!outcome.passing || tries >= retries || waitMs > MAX_RETRY_DELAY_MS) return yield* Effect.fail(exhausted(outcome));
        yield* attemptInItsWords('cancelled', () => pacer.pause(waitMs, signal));
      }
    }

    return yield* Effect.fail(new KinuError('unavailable', 'No web search is chosen for this account.'));
  }));
}

/**
 * The deployment's own Cloudflare search: the binding on the gateway `AI_GATEWAY_URL` names, billed to that account's
 * credits. Null where the Worker has no binding that searches or no gateway configured.
 */
export function bindingWebSearch(env: { readonly AI?: Partial<WorkersAiWebSearch>; readonly AI_GATEWAY_URL?: string }): DeploymentSearch | null {
  const websearch = workersAiWebSearch(env);
  const target = parseGatewayTarget(env.AI_GATEWAY_URL);

  if (websearch === undefined || 'reason' in target) return null;

  return ({ query, limit, provider }) => websearch({ gatewayId: target.id, query, limit, provider });
}
