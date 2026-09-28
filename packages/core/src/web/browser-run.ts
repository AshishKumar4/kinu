/**
 * Cloudflare Browser Run Quick Actions: one rendered page per call. A Worker reaches them through its
 * browser binding, the CLI through the REST API with an account token; both are a {@link QuickActionTransport}.
 * The binding takes `browser` in the options and the REST API as a query parameter; a body field is refused
 * there ("Unrecognized key: browser", measured 2026-09-28).
 */

import { Effect } from 'effect';
import * as v from 'valibot';
import { safeJsonParse, type JsonObject } from '../utils/json';
import { attempt, KinuError, settle } from '../obs/index';

export type QuickAction = 'content' | 'screenshot';

/**
 * Kitesurf renders the agent's one-shot actions: 3-7x less CPU and memory than Chrome for the same page
 * (developers.cloudflare.com/browser-run/kitesurf, 2026-09-28). It answers 501 for a webp screenshot; slate pictures use Chrome.
 */
export type QuickActionEngine = 'kitesurf' | 'chrome';

export type QuickActionOptions = JsonObject & { readonly url: string };

export type QuickActionTransport = (
  action: QuickAction, options: QuickActionOptions, engine: QuickActionEngine, signal?: AbortSignal,
) => Promise<Response>;

/** Structural, so core compiles without the Worker's ambient `BrowserRun`. */
export interface BrowserRunQuickActions {
  quickAction(action: QuickAction, options: QuickActionOptions): Promise<Response>;
}

/** Where Browser Run is reachable, or what a person must supply before it is. */
export type BrowserRunAccess = { readonly quickActions: QuickActionTransport } | { readonly missing: string };

export function bindingQuickActions(binding: BrowserRunQuickActions): QuickActionTransport {
  return (action, options, engine) => binding.quickAction(action, engine === 'kitesurf' ? { ...options, browser: engine } : options);
}

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

function restQuickActions(input: { readonly fetch: typeof fetch; readonly accountId: string; readonly apiToken: string }): QuickActionTransport {
  // Detached: workerd's fetch throws "Illegal invocation" when called as `input.fetch`.
  const fetchImpl = input.fetch;

  return (action, options, engine, signal) => fetchImpl(
    `${CLOUDFLARE_API}/accounts/${encodeURIComponent(input.accountId)}/browser-run/${action}${engine === 'kitesurf' ? '?browser=kitesurf' : ''}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${input.apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(options),
      signal,
    },
  );
}

/**
 * Browser Run from outside a Worker: the account and token wrangler reads, a token with "Browser Rendering -
 * Edit". Kinu's Cloudflare sign-in does not ask for that scope, so it cannot stand in.
 */
export function restBrowserRunAccess(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
}): BrowserRunAccess {
  const accountId = input.env['CLOUDFLARE_ACCOUNT_ID'];
  const apiToken = input.env['CLOUDFLARE_API_TOKEN'];

  if (!accountId || !apiToken) {
    return { missing: 'Browser Run needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (a token with Browser Rendering - Edit) in the environment the CLI runs in' };
  }

  return { quickActions: restQuickActions({ fetch: input.fetch, accountId, apiToken }) };
}

const FailureSchema = v.object({ errors: v.array(v.object({ message: v.string() })) });

/** The answer of one Quick Action, or its refusal in Browser Run's own words. */
export function quickAction(input: {
  readonly transport: QuickActionTransport;
  readonly action: QuickAction;
  readonly options: QuickActionOptions;
  readonly engine: QuickActionEngine;
  readonly signal?: AbortSignal;
}): Promise<Response> {
  return settle(answered(input));
}

function answered(input: Parameters<typeof quickAction>[0]): Effect.Effect<Response, KinuError> {
  const doing = `asking Browser Run for a ${input.action}`;

  return Effect.gen(function* () {
    const response = yield* attempt({ doing, otherwise: 'unavailable' }, () => input.transport(input.action, input.options, input.engine, input.signal));

    if (response.ok) return response;
    const body = yield* attempt({ doing, otherwise: 'unavailable' }, () => response.text());
    const parsed = v.safeParse(FailureSchema, safeJsonParse(body));
    const reason = parsed.success ? parsed.output.errors.map((error) => error.message).join('; ') : body.slice(0, 300);

    if (response.status === 429) return yield* Effect.fail(new KinuError('unavailable', `Browser Run is rate-limiting this account: ${reason}`));

    return yield* Effect.fail(new KinuError(
      response.status >= 500 ? 'unavailable' : 'bad_input',
      `Browser Run refused the ${input.action} (${response.status}): ${reason}`,
    ));
  });
}

