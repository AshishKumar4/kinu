/**
 * The signed-in account's search, asked of its deployment: the route runs the account's own chain where its keys are
 * sealed (`search-chain.ts`) and answers the search as the `web` tool reads it. A CLI signed in to Kinu searches here;
 * Settings' Test asks one entry through it.
 */
import * as v from 'valibot';
import { WebSearchRouteSchema } from '../providers/web-search';
import { WEB } from '../operations/web';
import { attemptInItsWords, ERROR_CODES, KinuError, settle } from '../obs/index';
import { Effect } from 'effect';
import type { WebSearch } from './search-chain';

/** `POST`, CLI-bearer gated as the inference proxy is. */
export const USER_WEB_SEARCH_PATH = '/api/user/web/search';

/** `POST`, behind the session: Settings' Test of one entry of the chain. */
export const USER_WEB_SEARCH_TEST_PATH = '/api/user/web-search/test';

export const WebSearchRequestSchema = v.strictObject({
  query: v.pipe(v.string(), v.nonEmpty()),
  limit: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(20)),
  /** One entry instead of the account's chain, asked once. */
  route: v.optional(WebSearchRouteSchema),
});

/** A refusal as `routeError` answers it (`publicError`). */
const RouteRefusalSchema = v.object({ error: v.string(), code: v.picklist(ERROR_CODES) });

/** Search through the signed-in account's route at `origin`, as the CLI reaches the platform's models. */
export function routeWebSearch(input: { readonly origin: string; readonly token: string; readonly fetch: typeof fetch }): WebSearch {
  const url = `${input.origin.replace(/\/+$/, '')}${USER_WEB_SEARCH_PATH}`;
  const fetchImpl = input.fetch;

  return ({ query, limit, signal }) => settle(Effect.gen(function* () {
    const res = yield* attemptInItsWords('unavailable', () => fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, limit }),
      ...(signal !== undefined && { signal }),
    }));

    const body = yield* attemptInItsWords('io', () => res.text());

    if (!res.ok) {
      const refusal = v.safeParse(v.pipe(v.string(), v.parseJson(), RouteRefusalSchema), body);

      return yield* Effect.fail(refusal.success
        ? new KinuError(refusal.output.code, refusal.output.error)
        : new KinuError('unavailable', `Your Kinu account's search answered ${res.status}: ${body.slice(0, 200)}`));
    }

    const answered = v.safeParse(v.pipe(v.string(), v.parseJson(), WEB.search.output), body);

    if (!answered.success) return yield* Effect.fail(new KinuError('io', `Your Kinu account's search answered in a shape this CLI does not read: ${body.slice(0, 200)}`));

    return answered.output;
  }));
}
