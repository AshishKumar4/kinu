// An account's AI Gateway credits as the account object reads them (core providers/gateway-credits.ts): the Cloudflare
// account its own login bills searches to, or the deployment's, with the token every deploy mints for it.
import { Effect } from 'effect';
import * as v from 'valibot';
import { NIMBUS_CLOUDFLARE_API as CLOUDFLARE_API } from '@nimbus-sh/sdk/oauth';
import { CreditBalanceSchema, creditBalancePath, creditsOf, type GatewayCredits } from '@kinu.run/core';
import { attempt, KinuError } from '@kinu.run/core/obs';

const CreditsEnvelopeSchema = v.object({
  success: v.boolean(),
  result: v.nullish(CreditBalanceSchema),
  errors: v.optional(v.array(v.object({ message: v.string() })), []),
});

/** `account`'s credits, read with `token`; a refusal fails in Cloudflare's words. */
export function fetchGatewayCredits(account: string, token: string, fetchImpl: typeof fetch = fetch): Effect.Effect<GatewayCredits, KinuError> {
  return Effect.gen(function* () {
    const doing = { doing: "reading this account's AI credits", otherwise: 'unavailable' } as const;

    const response = yield* attempt(doing, (signal) => fetchImpl(`${CLOUDFLARE_API}${creditBalancePath(account)}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` }, signal,
    }));

    const read = v.safeParse(CreditsEnvelopeSchema, yield* attempt(doing, async () => response.json()));

    if (!read.success) return yield* new KinuError('unavailable', `Cloudflare answered the AI credits read with HTTP ${String(response.status)} in a shape Kinu does not know.`);
    const { result, errors } = read.output;

    if (!response.ok || result === null || result === undefined) {
      const said = errors.map((error) => error.message).join('; ') || `HTTP ${String(response.status)}`;

      return yield* new KinuError(response.status === 401 || response.status === 403 ? 'denied' : 'unavailable', `Cloudflare refused reading the AI credits: ${said}.`);
    }

    return creditsOf(result);
  });
}
