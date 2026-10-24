// A provider refusing the country or region a call came from: its own words, with the data center that heard the call.
import { describe, expect, test } from 'bun:test';
import { withRegionReason } from '../src/providers/middleware/region-refusal';

const refused = (body: string, ray = 'a4f8eb9d1c5903b7-HKG') =>
  new Response(body, { status: 403, statusText: 'Forbidden', headers: { 'content-type': 'application/json', 'cf-ray': ray } });

const OPENAI_REGION = JSON.stringify({ error: { code: 'unsupported_country_region_territory', message: 'Country, region, or territory not supported', param: null, type: 'request_forbidden' } });

describe('a provider\'s region refusal', () => {
  test('OpenAI\'s keeps its own fields, and its message says where the call came from', async () => {
    const said = await withRegionReason(refused(OPENAI_REGION));

    expect(said.status).toBe(403);
    expect(await said.json()).toEqual({
      error: {
        code: 'unsupported_country_region_territory', param: null, type: 'request_forbidden',
        message: 'Country, region, or territory not supported: OpenAI does not serve its API in the country or region this call came from (Cloudflare\'s HKG data center).',
      },
    });
  });

  test('Anthropic\'s is put in the envelope its SDK reads, the provider named by its refusal\'s shape wherever it was routed', async () => {
    const said = await withRegionReason(refused('{"error":{"type":"forbidden","message":"Request not allowed"}}'));

    expect(await said.json()).toEqual({
      type: 'error',
      error: { type: 'forbidden', message: 'Request not allowed: Anthropic does not serve its API in the country or region this call came from (Cloudflare\'s HKG data center).' },
    });
  });

  test('any other refusal, and any answer but a 403, passes as it came', async () => {
    const other = refused('{"type":"error","error":{"type":"permission_error","message":"Your plan does not include this model."}}');

    expect(await (await withRegionReason(other)).text()).toContain('Your plan does not include this model.');

    const ok = new Response('{"ok":true}', { status: 200 });

    expect(await withRegionReason(ok)).toBe(ok);
  });
});
