/**
 * The deployment's own web search for a CLI signed in to it: the same Cloudflare Web Search API call a workspace's
 * search makes through the binding, on the platform's gateway. The API's response is handed back as it came, so the
 * CLI reads it as the Worker does (core `web/provider.ts`).
 */
import { Hono } from 'hono';
import * as v from 'valibot';
import { bindingWebSearch, errorResponse, safeJson, USER_WEB_SEARCH_PATH, WebSearchRequestSchema, type WorkersAiWebSearch } from '@kinu.run/core';
import type { FamilyEnv } from '../api/context';
import { inferenceProxyGate, type CliBearerEnv, type CliBearerVariables } from '../api/cli-bearer';
import type { CliAuthAuthority } from '../cli/auth-store';

interface WebSearchRouteEnv extends CliBearerEnv<CliAuthAuthority> {
  readonly AI?: Partial<WorkersAiWebSearch>;
  readonly AI_GATEWAY_URL?: string;
}

export const webSearchRoutes = new Hono<FamilyEnv<WebSearchRouteEnv, CliBearerVariables<CliAuthAuthority>>>();

// Exactly this path: `beneath` gates only what lies below a prefix, and this route is the path itself.
webSearchRoutes.use(USER_WEB_SEARCH_PATH, inferenceProxyGate());

webSearchRoutes.post(USER_WEB_SEARCH_PATH, async (c) => {
  const body: v.InferOutput<typeof WebSearchRequestSchema> | null = await safeJson(c.req.raw, WebSearchRequestSchema);

  if (body === null) return errorResponse(400, 'Body must be { query, limit }.');
  // Filed nowhere here, as the inference proxy's completions are: no workspace's ledger holds a CLI's calls.
  const search = bindingWebSearch(c.env, () => undefined);

  if (search === null) return errorResponse(503, 'Web search is not available on this deployment.');

  return search.search(body);
});
