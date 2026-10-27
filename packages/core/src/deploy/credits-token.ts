// The token a deployment reads its own AI credits with (cf-backend user/gateway-credits.ts): AI Gateway Read on its
// account, and nothing else, minted from the person's grant (instance-token.ts).
import { Effect } from 'effect';
import type { KinuError } from '../obs/index';
import { scriptBindings } from './account';
import type { DeployContext } from './context';
import { CREDITS_TOKEN_SECRET } from './inputs';
import { instanceToken, scopeRefused } from './instance-token';
import type { DeployStep } from './steps';

/** Cloudflare's name for its one permission (the account's permission groups, read 2026-10-27). */
const AI_GATEWAY_READ = 'AI Gateway Read';

/** Before the upload, which binds it. A version that holds one keeps it (`keep_bindings`); one from before this step is
 *  given one. Where Cloudflare will not mint it, the deployment shows no credits, and runs as before. */
export function creditsTokenStep(): DeployStep {
  return {
    id: 'credits-token',
    title: 'Mint the token that reads its AI credits',
    after: ['account'],
    run(context: DeployContext): Effect.Effect<string, KinuError> {
      return Effect.gen(function* () {
        const { accountId, instanceName } = context.inputs;

        if (context.update && (yield* scriptBindings(context.transport, accountId, instanceName)).some((binding) => binding.name === CREDITS_TOKEN_SECRET)) {
          return 'The running version keeps its credits token.';
        }

        const name = `${instanceName} AI credits (Kinu)`;

        const outcome = yield* instanceToken(context, { name, permission: AI_GATEWAY_READ, resource: `com.cloudflare.api.account.${accountId}`, secret: CREDITS_TOKEN_SECRET })
          .pipe(Effect.catchCause((failed) => (scopeRefused(failed) ? Effect.succeed('refused' as const) : Effect.failCause(failed))));

        if (outcome === 'refused') return 'No credits token: Cloudflare refused minting one, so this Kinu shows no AI credits.';

        if (outcome === 'kept') return 'The credits token is minted.';

        return outcome === 'minted' ? `Minted "${name}", which may read this account's AI Gateway and nothing else.` : `Rolled "${name}": this run had lost its value.`;
      });
    },
  };
}
