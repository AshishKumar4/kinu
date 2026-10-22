/**
 * The deploy door's OAuth client against the one list it is registered from (core deploy/pkce.ts
 * `CLOUDFLARE_DEPLOY_CLIENT`): its required and optional scopes, as Cloudflare holds them for the client every Kinu's
 * consent names (`CLOUDFLARE_DEPLOY_CLIENT_ID`). The registration drifted from the list once, and the owner's consent
 * was refused for a scope it held (f44999, 2026-10-21).
 *
 *   bun scripts/deploy-oauth-client.ts check   exits 1, naming each difference
 *   bun scripts/deploy-oauth-client.ts sync    registers the list's scopes on the client, then checks it
 *
 * Its token is `KINU_OAUTH_CLIENT_TOKEN`, an account token with OAuth Clients Read and Write.
 */
import * as v from 'valibot';
import { CLOUDFLARE_DEPLOY_CLIENT, deployClientDrift } from '../packages/core/src/deploy/pkce';
import { restCall } from './cloudflare-rest';
import { deployedConfig } from './infra-manifest';

const ClientSchema = v.object({
  result: v.object({ client_id: v.string(), scopes: v.array(v.string()), optional_scopes: v.nullish(v.array(v.string())) }),
});

/** The client every environment's door names, and the account that owns it. */
function deployClient() {
  const config = deployedConfig('production');
  const id = config.vars?.['CLOUDFLARE_DEPLOY_CLIENT_ID'];

  if (typeof id !== 'string' || id === '' || config.account_id === undefined) throw new Error('the production config names no deploy OAuth client and account');

  return { account: config.account_id, id };
}

async function registered(token: string) {
  const { account, id } = deployClient();
  const { result } = await restCall({ method: 'GET', path: `/accounts/${account}/oauth_clients/${id}`, token }, ClientSchema);

  return { scopes: result.scopes, optional: result.optional_scopes ?? [] };
}

async function main(): Promise<number> {
  const command = process.argv[2];
  const token = process.env['KINU_OAUTH_CLIENT_TOKEN'] ?? '';

  if (token === '') throw new Error('reading the deploy OAuth client needs KINU_OAUTH_CLIENT_TOKEN (OAuth Clients Read and Write)');

  if (command === 'sync') {
    const { account, id } = deployClient();

    await restCall({
      method: 'PATCH', path: `/accounts/${account}/oauth_clients/${id}`, token,
      body: { scopes: CLOUDFLARE_DEPLOY_CLIENT.scopes, optional_scopes: CLOUDFLARE_DEPLOY_CLIENT.optional },
    }, v.object({ success: v.literal(true) }));
  } else if (command !== 'check') {
    throw new Error('usage: deploy-oauth-client.ts check | sync');
  }

  const drift = deployClientDrift(await registered(token));

  for (const difference of drift) process.stderr.write(`deploy OAuth client: ${difference}\n`);

  if (drift.length === 0) process.stdout.write('deploy OAuth client: registered as core deploy/pkce.ts lists it\n');

  return drift.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
