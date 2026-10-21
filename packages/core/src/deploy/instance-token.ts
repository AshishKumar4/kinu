// The one way a run gives its deployment a Cloudflare token of its own (docs/SELF-DEPLOY-FLOW.md § 7): minted from the
// person's grant, never asked of them, and kept in the run's vault under the secret the upload binds.
import { Effect } from 'effect';
import * as v from 'valibot';
import type { KinuError } from '../obs/index';
import { cloudflareResult } from './cloudflare';
import type { DeployContext } from './context';

const NamedSchema = v.array(v.object({ id: v.string(), name: v.string() }));

export interface InstanceToken {
  /** Its name in the account's tokens, which finds it again on a later run. */
  readonly name: string;
  /** The permission group it holds, by Cloudflare's name for it. */
  readonly permission: string;
  /** What it may touch: `com.cloudflare.api.account.<id>` or `com.cloudflare.api.account.zone.<id>`. */
  readonly resource: string;
  readonly secret: string;
  /** The secret's value around the token, where it carries more than the token. */
  readonly stored?: (token: string) => string;
}

/**
 * The token in the vault: minted where the account holds none by its name, rolled where a run lost the value of the one
 * it minted, and left as it is where the vault holds it.
 */
export function instanceToken(context: DeployContext, token: InstanceToken): Effect.Effect<'kept' | 'minted' | 'rolled', KinuError> {
  return Effect.gen(function* () {
    if ((yield* Effect.promise(async () => context.vault.read(token.secret))) !== null) return 'kept';
    const account = context.inputs.accountId;

    const tokens = yield* Effect.promise(async () => cloudflareResult(context.transport, { method: 'GET', path: `/accounts/${account}/tokens?per_page=50` }, NamedSchema));
    const held = tokens.find((each) => each.name === token.name);

    const value = held === undefined ? yield* minted(context, token) : yield* Effect.promise(async () => cloudflareResult(
      context.transport, { method: 'PUT', path: `/accounts/${account}/tokens/${held.id}/value`, body: {} }, v.string(),
    ));

    yield* Effect.promise(async () => context.vault.write(token.secret, token.stored?.(value) ?? value));

    return held === undefined ? 'minted' : 'rolled';
  });
}

function minted(context: DeployContext, token: InstanceToken): Effect.Effect<string, KinuError> {
  return Effect.gen(function* () {
    const account = context.inputs.accountId;

    const groups = yield* Effect.promise(async () => cloudflareResult(
      context.transport, { method: 'GET', path: `/accounts/${account}/tokens/permission_groups?name=${encodeURIComponent(token.permission)}` }, NamedSchema,
    ));

    const group = groups.find((entry) => entry.name === token.permission);

    if (group === undefined) return yield* Effect.die(new Error(`Cloudflare lists no "${token.permission}" permission for this account`));

    const answer = yield* Effect.promise(async () => cloudflareResult(
      context.transport,
      {
        method: 'POST',
        path: `/accounts/${account}/tokens`,
        body: { name: token.name, policies: [{ effect: 'allow', resources: { [token.resource]: '*' }, permission_groups: [{ id: group.id }] }] },
      },
      v.object({ value: v.string() }),
    ));

    return answer.value;
  });
}
