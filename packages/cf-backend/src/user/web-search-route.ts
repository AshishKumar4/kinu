/**
 * A signed-in account's web search, asked of the deployment: a CLI's search (behind the inference proxy's bearer gate)
 * and Settings' Test of one entry (behind the session). Both run the account's chain here, where its keys are sealed
 * (core `web/search-chain.ts`), and answer the search as the `web` tool reads it.
 */
import { Hono } from 'hono';
import * as v from 'valibot';
import {
  bindingWebSearch, chainWebSearch, objectNamed, ownerCaller, safeJson, json, webSearchChainOf, USER_WEB_SEARCH_PATH, WebSearchRequestSchema,
  type AuthResolver, type OwnerCapabilityEnv, type ProfileCatalogEnvelope, type UserCaller, type WebSearchResponse, type WorkersAiWebSearch,
} from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';
import type { FamilyEnv } from '../api/context';
import { inferenceProxyGate, type CliBearerEnv, type CliBearerVariables } from '../api/cli-bearer';
import type { CliAuthAuthority } from '../cli/auth-store';
import { userCredentials, type UserCredentialClient } from '../providers/agent-registry';

/** What a search reads of the account: its keys and Cloudflare login, and its catalog's chain. */
export interface SearchingAccount {
  readonly getAuth: AuthResolver;
  readonly catalog: () => Promise<ProfileCatalogEnvelope>;
}

export interface WebSearchEnv {
  readonly AI?: Partial<WorkersAiWebSearch>;
  readonly AI_GATEWAY_URL?: string;
}

/** One search as `account`: its chain, or the one entry the body names, asked once. Filed nowhere, as the inference
 *  proxy's completions are: no workspace's ledger holds it. */
export async function searchAsAccount(env: WebSearchEnv, account: SearchingAccount, request: Request): Promise<WebSearchResponse> {
  const body: v.InferOutput<typeof WebSearchRequestSchema> | null = await safeJson(request, WebSearchRequestSchema);

  if (body === null) throw new KinuError('bad_input', 'Body must be { query, limit, route? }.');
  const { route } = body;
  const deployment = bindingWebSearch(env);

  const search = chainWebSearch({
    fetch: globalThis.fetch,
    getAuth: account.getAuth,
    ...(deployment !== null && { deployment }),
    report: () => undefined,
    chain: async () => (route === undefined ? webSearchChainOf((await account.catalog()).catalog) : { routes: [route], retries: 0 }),
  });

  return await search({ query: body.query, limit: body.limit });
}

type SearchAuthority = CliAuthAuthority & UserCredentialClient & { getProfileCatalog(caller: UserCaller): Promise<ProfileCatalogEnvelope> };

type WebSearchRouteEnv = CliBearerEnv<SearchAuthority> & WebSearchEnv & OwnerCapabilityEnv;

export const webSearchRoutes = new Hono<FamilyEnv<WebSearchRouteEnv, CliBearerVariables<SearchAuthority>>>();

// Exactly this path: `beneath` gates only what lies below a prefix, and this route is the path itself.
webSearchRoutes.use(USER_WEB_SEARCH_PATH, inferenceProxyGate());

webSearchRoutes.post(USER_WEB_SEARCH_PATH, async (c) => {
  const owner = await ownerCaller(c.env);
  const stub = () => objectNamed(c.env.UserDO, c.get('cli').userId);

  return json({ body: await searchAsAccount(c.env, { getAuth: userCredentials(stub, owner).getAuth, catalog: () => stub().getProfileCatalog(owner) }, c.req.raw) });
});
