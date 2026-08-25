// Transport for the PLATFORM AI Gateway provider (providers/ai-gateway.ts):
// the AI SDK's OpenAI-compatible request, carried over the Workers AI binding
// instead of over the wire.
//
// Why: the HTTPS path to the gateway needs a Cloudflare API token with Workers
// AI permissions (docs/DEPLOYMENT.md) even though the Worker already runs INSIDE
// the gateway's own account. `env.AI.gateway(id).run(...)` is pre-authenticated
// in-account, so the platform provider needs no secret at all — same account,
// same bill, one fewer credential to mint and rotate.
//
// Two measured constraints, both easy to undo by accident:
//  * a request-supplied `authorization` header OVERRIDES the binding's
//    in-account pre-authentication and the gateway answers 401. Auth headers are
//    stripped here; nothing upstream may add one back.
//  * `run` is the only binding call that hands back a `Response`, which is what
//    an AI SDK `fetch` seam consumes — `env.AI.run()` returns a parsed object and
//    would force a hand-rolled SSE re-serializer. It carries the non-deprecated
//    `v1/chat/completions` endpoint and streams incrementally (measured: headers
//    at ~1s, then 390 chunks over the following second).
import { asFetchFunction } from './fetch-shim';
import type { GatewayRunRequest, WorkersAIBinding } from './types';
import { renderThrownChain } from '../obs/index';
import { copyHeaders } from './util';

/** An AI Gateway HTTPS base parsed into what the binding addresses it by.
 *  `AI_GATEWAY_URL` is the single source of truth for both. */
export interface GatewayTarget {
  /** Gateway name. The binding resolves it in the Worker's OWN account, so a
   *  URL naming a foreign account's gateway fails loudly at request time. */
  id: string;
  /** Origin the SDK's requests must sit on. */
  origin: string;
  /** Pathname through `{gateway}/`. Everything after it is `{provider}/{endpoint}`. */
  prefix: string;
}

/** A parsed target, or why the configured value is not one. The failure carries
 *  its cause so the provider can say which half of the config is wrong. */
export type GatewayTargetResult = GatewayTarget | { reason: string };

/** Parse `AI_GATEWAY_URL` into the gateway the binding addresses. */
export function parseGatewayTarget(raw: string | undefined): GatewayTargetResult {
  if (!raw) return { reason: 'AI_GATEWAY_URL var missing.' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    return {
      reason: `AI_GATEWAY_URL is not a URL: ${renderThrownChain({ cause: cause })}`,
    };
  }
  const [version, account, id] = url.pathname.split('/').filter(Boolean);
  if (version !== 'v1' || !account || !id) {
    return {
      reason: 'AI_GATEWAY_URL is not an AI Gateway URL (expected '
        + `{origin}/v1/{account}/{gateway}/{provider}/...), got ${JSON.stringify(raw)}.`,
    };
  }
  return { id, origin: url.origin, prefix: `/v1/${account}/${id}/` };
}

// Hop-by-hop and derived headers the binding must not re-send, plus gateway
// auth: binding calls are pre-authenticated and a supplied credential is treated
// as a BYOK override, which answers 401.
const STRIPPED_HEADERS = ['authorization', 'cf-aig-authorization', 'content-length', 'host'];

/** Any absolute URL; the Request wrapper below is only ever read, never sent. */
const BODY_SINK_URL = 'https://ai-gateway-binding.invalid/body';

export function createGatewayBindingFetch(opts: {
  binding: WorkersAIBinding;
  target: GatewayTarget;
}): typeof globalThis.fetch {
  const { binding, target } = opts;
  return asFetchFunction(async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const rawURL = request ? request.url : input.toString();
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    // Anything this transport cannot express is a wiring bug, not passthrough
    // traffic: forwarding it would send the request somewhere unintended and
    // report a misleading upstream error instead of naming the real problem.
    const reject = (why: string): never => {
      throw new Error(
        `ai-gateway binding transport cannot serve ${method} ${rawURL} (${why}). `
        + `It serves only its own gateway, ${target.origin}${target.prefix}.`,
      );
    };

    let url: URL;
    try {
      url = new URL(rawURL);
    } catch (cause) {
      return reject(`unparseable URL: ${renderThrownChain({ cause: cause })}`);
    }
    // Compare normalized origin + pathname, not raw strings, so a lexical
    // variant cannot split provider/endpoint differently than the wire would.
    if (url.origin !== target.origin || !url.pathname.startsWith(target.prefix)) {
      return reject('outside the configured gateway prefix');
    }
    if (method !== 'POST') return reject('the gateway binding accepts POST only');

    const rest = url.pathname.slice(target.prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 1) return reject('no provider/endpoint in the path');

    const bodyText = await readBodyText(request, init);
    if (bodyText === undefined) return reject('no request body');
    let query: unknown;
    try {
      query = JSON.parse(bodyText);
    } catch (cause) {
      return reject(`non-JSON request body: ${renderThrownChain({ cause: cause })}`);
    }

    const signal = init?.signal ?? request?.signal ?? undefined;
    return binding.gateway(target.id).run({
      provider: rest.slice(0, slash),
      // The query string belongs to the endpoint — it is part of what the wire
      // would have carried.
      endpoint: rest.slice(slash + 1) + url.search,
      headers: collectHeaders(request, init),
      query,
    }, signal ? { signal } : {});
  });
}

/** Read the request body as text through the platform's own Request parser, so
 *  every `BodyInit` shape is handled the way the wire would have handled it. */
async function readBodyText(
  request: Request | undefined,
  init: RequestInit | undefined,
): Promise<string | undefined> {
  const body = init?.body;
  // Per the fetch spec an explicit `body: null` in init clears a Request's body.
  if (body === null) return undefined;
  if (body === undefined) return request?.body ? request.clone().text() : undefined;
  return new Request(BODY_SINK_URL, { method: 'POST', body }).text();
}

/** Header names arrive lowercased from `Headers`, so case-variant duplicates
 *  collapse and stripping is uniform. Per the fetch spec `init.headers` replaces
 *  a Request's headers entirely rather than merging with them. */
function collectHeaders(
  request: Request | undefined,
  init: RequestInit | undefined,
): GatewayRunRequest['headers'] {
  const headers = copyHeaders(init?.headers === undefined ? request?.headers : init.headers);
  for (const name of STRIPPED_HEADERS) headers.delete(name);
  return Object.fromEntries(headers.entries());
}
