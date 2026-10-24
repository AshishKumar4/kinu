/**
 * A provider refusing the country or region a call came from, said in its own words and with where the call came from. A
 * cloud workspace calls from the Cloudflare data center its object runs in, and Anthropic and OpenAI serve their APIs only
 * in listed countries and regions (anthropic.com/supported-countries, developers.openai.com/api/docs/supported-countries):
 * from Hong Kong, api.anthropic.com answers every call 403 `Request not allowed` (measured from a Durable Object in HKG,
 * 2026-10-24). The refusing host's `cf-ray` ends in the data center it heard the call from.
 */
import * as v from 'valibot';
import { tolerate } from '../../obs/index';
import { JsonValueSchema, parseJsonValue, type JsonObject } from '../../utils/json';

/** Anthropic's: without the `type: 'error'` envelope its SDK reads, so the SDK showed only the status text, `Forbidden`. */
const AnthropicRegionSchema = v.object({ error: v.object({ type: v.literal('forbidden'), message: v.literal('Request not allowed') }) });

/** OpenAI's, by its documented text (developers.openai.com/api/docs/guides/error-codes). */
const OpenAIRegionSchema = v.objectWithRest({ error: v.objectWithRest({ message: v.literal('Country, region, or territory not supported') }, JsonValueSchema) }, JsonValueSchema);

/** The data center a Cloudflare-fronted host heard the call at, from its `cf-ray` (`<id>-<colo>`). A gateway passing the
 *  refusal on heard it at the same one: it calls from where its caller runs. */
function coloOf(response: Response): string | null {
  const colo = response.headers.get('cf-ray')?.split('-')[1];

  return colo !== undefined && /^[A-Z]{3}$/u.test(colo) ? colo : null;
}

function answered(refused: Response, body: JsonObject): Response {
  const headers = new Headers(refused.headers);

  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json');

  return new Response(JSON.stringify(body), { status: refused.status, statusText: refused.statusText, headers });
}

/** Why `provider` refused: the country or region the call came from, and the data center it came through. */
function why(provider: string, refused: Response): string {
  const colo = coloOf(refused);

  return `${provider} does not serve its API in the country or region this call came from${colo === null ? '' : ` (Cloudflare's ${colo} data center)`}.`;
}

/**
 * `refused` as it came, unless it is a provider's region refusal: then in the provider's envelope, its words and why. The
 * provider is known by its refusal's own shape, since a call routed through a gateway or a named endpoint is sent to a
 * host that is not the provider's.
 */
export async function withRegionReason(refused: Response): Promise<Response> {
  if (refused.status !== 403) return refused;
  const text = await refused.clone().text();
  const body = tolerate(() => parseJsonValue(text), 'malformed-input');

  if (v.is(AnthropicRegionSchema, body)) return answered(refused, { type: 'error', error: { type: 'forbidden', message: `Request not allowed: ${why('Anthropic', refused)}` } });

  if (v.is(OpenAIRegionSchema, body)) return answered(refused, { ...body, error: { ...body.error, message: `${body.error.message}: ${why('OpenAI', refused)}` } });

  return refused;
}
