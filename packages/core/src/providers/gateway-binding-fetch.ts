// Transport for the platform AI Gateway: the SDK's OpenAI-compatible request over the Workers AI binding
// (pre-authenticated in-account, so no API token).
// Measured: a request `authorization` header overrides binding auth (gateway 401), so auth is stripped;
// `shell` is the only binding call returning a `Response`, which the SDK `fetch` seam needs.
import { asFetchFunction } from './fetch-shim';
import type { GatewayRunRequest, WorkersAIBinding } from './types';
import { renderThrownChain } from '../obs/index';
import { copyHeaders } from './util';

/** An AI Gateway HTTPS base parsed into what the binding addresses; `AI_GATEWAY_URL` is the source for both. */
export interface GatewayTarget {
  /** Gateway name, resolved in the Worker's own account; a foreign account's gateway fails at request time. */
  id: string;
  /** Origin the SDK's requests must sit on. */
  origin: string;
  /** Pathname through `{gateway}/`. Everything after it is `{provider}/{endpoint}`. */
  prefix: string;
}

/** A parsed target, or why the configured value is not one. */
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

// Hop-by-hop headers plus gateway auth: a supplied credential is a BYOK override and answers 401.
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
    const rawURL = input instanceof Request ? input.url : input.toString();
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();

    // Anything this transport cannot express is a wiring bug, not passthrough traffic.
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

    // Compare normalized origin + pathname so a lexical variant cannot split provider/endpoint differently.
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
      // The query string belongs to the endpoint.
      endpoint: rest.slice(slash + 1) + url.search,
      headers: collectHeaders(request, init),
      query,
    }, signal ? { signal } : {});
  });
}

/** The request body as text, via the platform's Request parser so every `BodyInit` shape is handled. */
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

/** Header names arrive lowercased. Per the fetch spec `init.headers` replaces a Request's headers, not merges. */
function collectHeaders(
  request: Request | undefined,
  init: RequestInit | undefined,
): GatewayRunRequest['headers'] {
  const headers = copyHeaders(init?.headers ?? request?.headers);

  for (const name of STRIPPED_HEADERS) headers.delete(name);

  return Object.fromEntries(headers.entries());
}
