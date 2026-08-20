// Behavior tests for the general provider proxy's client half — the wire
// contract that lets a machine holding no secret drive a provider whose key
// lives in the owner's Kinu account.
//
// Contract under test:
//   - a proxied AuthResolution carries a marker, never secret material
//   - the fetch wrapper relocates only marked requests, verbatim otherwise
//   - the base URL a credential may be spent on is derivable from the key
//   - target admission is origin + path-prefix, https only
import { describe, expect, test } from 'bun:test';
import {
  PROXY_CRED_HEADER, PROXY_TARGET_HEADER,
  createProviderProxyFetch, providerProxyBaseURL, providerProxyForwardURL,
  proxyAuthResolution, proxyTargetAllowed,
} from '../src/providers/proxy';
import { asFetchFunction } from '../src/providers/fetch-shim';

const CATALOG = {
  groq: { id: 'groq', name: 'Groq', npm: '@ai-sdk/groq', models: {} },
  fireworks: {
    id: 'fireworks', name: 'Fireworks', npm: '@ai-sdk/openai-compatible',
    api: 'https://api.fireworks.ai/inference/v1', models: {},
  },
  bespoke: { id: 'bespoke', name: 'Bespoke SDK only', npm: '@ai-sdk/bespoke', models: {} },
};

/** A fetch identity of its own so the models.dev module cache never bleeds
 *  between tests (it keys on the function object). */
function catalogFetch(): typeof fetch {
  return asFetchFunction(async () => Response.json(CATALOG));
}

describe('proxied auth resolution', () => {
  test('carries a marker naming the credential and no secret material', () => {
    const resolution = proxyAuthResolution('openrouter.bearer');
    expect(resolution.headers).toEqual({ [PROXY_CRED_HEADER]: 'openrouter.bearer' });
    expect(resolution.baseURL).toBeUndefined();
  });

  test('passes a credential-owned base URL through for the placeholder rewrite', () => {
    expect(proxyAuthResolution('openai-compat.default', 'https://host.example/v1').baseURL)
      .toBe('https://host.example/v1');
  });

});

describe('provider proxy fetch', () => {
  function capture() {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const impl = asFetchFunction(async (input, init) => {
      seen.push({ url: String(input), init });
      return new Response('ok');
    });
    return { seen, fetch: impl };
  }

  test('relocates a marked request and swaps in the caller bearer', async () => {
    const { seen, fetch: base } = capture();
    const proxied = createProviderProxyFetch({
      forwardURL: providerProxyForwardURL('https://kinu.example.com/'),
      authorization: 'Bearer ptc_test',
      fetch: base,
    });

    await proxied('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        [PROXY_CRED_HEADER]: 'openrouter.bearer',
        authorization: 'Bearer placeholder',
        'content-type': 'application/json',
      },
      body: '{"model":"x"}',
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://kinu.example.com/api/user/ai/proxy/forward');
    const headers = new Headers(seen[0]?.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer ptc_test');
    expect(headers.get(PROXY_CRED_HEADER)).toBe('openrouter.bearer');
    expect(headers.get(PROXY_TARGET_HEADER)).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(headers.get('content-type')).toBe('application/json');
    expect(seen[0]?.init?.method).toBe('POST');
    expect(seen[0]?.init?.body).toBe('{"model":"x"}');
  });

  test('leaves an unmarked request exactly as it was — a local key still goes direct', async () => {
    const { seen, fetch: base } = capture();
    const proxied = createProviderProxyFetch({
      forwardURL: 'https://kinu.example.com/api/user/ai/proxy/forward',
      authorization: 'Bearer ptc_test',
      fetch: base,
    });

    await proxied('https://api.openai.com/v1/models', { headers: { authorization: 'Bearer sk-local' } });

    expect(seen[0]?.url).toBe('https://api.openai.com/v1/models');
    expect(new Headers(seen[0]?.init?.headers).get('authorization')).toBe('Bearer sk-local');
  });

  test('attaches session headers to proxied requests', async () => {
    const { seen, fetch: base } = capture();
    const proxied = createProviderProxyFetch({
      forwardURL: 'https://kinu.example.com/api/user/ai/proxy/forward',
      authorization: 'Bearer ptc_test',
      headers: { 'x-session-affinity': 'kinu-alpha' },
      fetch: base,
    });
    await proxied('https://openrouter.ai/api/v1/models', { headers: { [PROXY_CRED_HEADER]: 'openrouter.bearer' } });
    expect(new Headers(seen[0]?.init?.headers).get('x-session-affinity')).toBe('kinu-alpha');
  });
});

describe('providerProxyBaseURL', () => {
  test('statically registered providers answer from the adapter, not the catalog', async () => {
    const deps = { fetch: catalogFetch() };
    expect(await providerProxyBaseURL('openai.bearer', deps)).toBe('https://api.openai.com/v1');
    expect(await providerProxyBaseURL('anthropic.bearer', deps)).toBe('https://api.anthropic.com/v1');
    expect(await providerProxyBaseURL('openrouter.bearer', deps)).toBe('https://openrouter.ai/api/v1');
  });

  test('catalog providers answer from models.dev, including the pinned supplement', async () => {
    const deps = { fetch: catalogFetch() };
    expect(await providerProxyBaseURL('fireworks.bearer', deps)).toBe('https://api.fireworks.ai/inference/v1');
    expect(await providerProxyBaseURL('groq.bearer', deps)).toBe('https://api.groq.com/openai/v1');
  });

  test('refuses the credentials the proxy is not allowed to spend', async () => {
    const deps = { fetch: catalogFetch() };
    // The Cloudflare bearer also authorizes account administration…
    expect(await providerProxyBaseURL('cloudflare.oauth', deps)).toBeNull();
    expect(await providerProxyBaseURL('cloudflare.ai-gateway', deps)).toBeNull();
    // …and Codex refuses Worker egress, so proxying it would break a local
    // credential that works today.
    expect(await providerProxyBaseURL('codex.oauth', deps)).toBeNull();
  });

  test('returns null when no endpoint is derivable', async () => {
    const deps = { fetch: catalogFetch() };
    expect(await providerProxyBaseURL('bespoke.bearer', deps)).toBeNull();
    expect(await providerProxyBaseURL('openai-compat.default', deps)).toBeNull();
    expect(await providerProxyBaseURL('github', deps)).toBeNull();
  });
});

describe('proxyTargetAllowed', () => {
  const base = 'https://api.groq.com/openai/v1';

  test('admits the endpoints running a model needs', () => {
    for (const endpoint of [
      '/chat/completions', '/completions', '/responses', '/responses/resp_123',
      '/messages', '/messages/count_tokens', '/embeddings', '/models', '/models/gpt-5.5',
    ]) {
      expect(proxyTargetAllowed(`${base}${endpoint}`, base)).toBe(true);
    }
    expect(proxyTargetAllowed(`${base}/models?x=1`, base)).toBe(true);
  });

  test("refuses the provider's own account management — the key-minting case", () => {
    for (const endpoint of [
      '/keys', '/key', '/organization/admin_api_keys', '/organizations/api_keys',
      '/credits', '/billing/usage', '',
    ]) {
      expect(proxyTargetAllowed(`${base}${endpoint}`, base)).toBe(false);
    }
  });

  test('refuses a URL carrying credentials — fetch cannot send it anyway', () => {
    expect(proxyTargetAllowed('https://user:pass@api.groq.com/openai/v1/chat/completions', base)).toBe(false);
  });

  test('refuses another host — the exfiltration case', () => {
    expect(proxyTargetAllowed('https://attacker.example/openai/v1/chat/completions', base)).toBe(false);
    expect(proxyTargetAllowed('https://api.groq.com.attacker.example/openai/v1', base)).toBe(false);
  });

  test('refuses a sibling path that merely shares a prefix', () => {
    expect(proxyTargetAllowed('https://api.groq.com/openai/v1x/chat', base)).toBe(false);
    expect(proxyTargetAllowed('https://api.groq.com/admin', base)).toBe(false);
  });

  test('refuses non-https and unparseable targets', () => {
    expect(proxyTargetAllowed('http://api.groq.com/openai/v1/chat', base)).toBe(false);
    expect(proxyTargetAllowed('not a url', base)).toBe(false);
  });

  test('a base with a trailing slash admits the same descendants', () => {
    expect(proxyTargetAllowed(`${base}/chat/completions`, `${base}/`)).toBe(true);
  });
});
