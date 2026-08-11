// Behavior tests for the general provider proxy (/api/user/ai/proxy/*) — the
// route that makes a key connected in the web UI usable by a local agent with
// no second copy of the secret on that machine.
//
// Contract under test:
//   - auth: the same CLI-bearer gate the Cloudflare-pinned proxy uses
//   - GET /credentials lists proxyable keys and never a secret
//   - POST /forward attaches the credential server-side and streams through
//   - a target outside the credential's own endpoint is refused (exfiltration)
//   - the Cloudflare login is never attached to a client-chosen URL
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do.js';
import { afterEach, describe, expect, test } from 'bun:test';
import { handleCliRequest } from '../src/cli/routes.js';

const USER_ID = '0123456789abcdef0123456789abcdef';
const SESSION_TOKEN = `ptc_${USER_ID}_abcdefghijklmnopqrstuvwxyz`;
const AI_TOKEN = `pta_${USER_ID}_${'a'.repeat(44)}`;
const READ_TOKEN = `pta_${USER_ID}_${'r'.repeat(44)}`;

const FORWARD_URL = 'https://proteus.example.com/api/user/ai/proxy/forward';
const CREDENTIALS_URL = 'https://proteus.example.com/api/user/ai/proxy/credentials';

const CATALOG = {
  groq: { id: 'groq', name: 'Groq', npm: '@ai-sdk/groq', models: {} },
};

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

interface StoredCredential { key: string; baseURL?: string; headers?: Record<string, string> }

function setupEnv(stored: StoredCredential[]) {
  const byKey = new Map(stored.map((c) => [c.key, c]));
  const userDO = {
    async verifyCliToken(_caller: unknown, bearer: string) {
      return {
        ok: bearer === SESSION_TOKEN,
        tokenHash: 'session-hash',
        user: { id: USER_ID, email: 'ashish@example.com', displayName: 'Ashish' },
      };
    },
    async verifyAccessToken(_caller: unknown, bearer: string) {
      const scopes = bearer === AI_TOKEN ? ['ai.proxy'] : bearer === READ_TOKEN ? ['workspace.read'] : null;
      if (!scopes) return { ok: false, error: 'invalid token' };
      return {
        ok: true,
        tokenHash: `${scopes.join('+')}-hash`,
        scopes,
        user: { id: USER_ID, email: 'ashish@example.com', displayName: 'Ashish' },
      };
    },
    async listCredentials(_caller: unknown) {
      return stored.map((c) => ({ key: c.key, kind: 'bearer', createdAt: 0, updatedAt: 0 }));
    },
    async getCredentialBaseURL(_caller: unknown, key: string) {
      return byKey.get(key)?.baseURL ?? null;
    },
    async getAuthHeaders(_caller: unknown, key: string) {
      return byKey.get(key)?.headers ?? null;
    },
  };
  return { UserDO: { idFromName: (n: string) => n, get: () => userDO }, CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY } as unknown as Env;
}

function forwardRequest(opts: {
  token?: string | null;
  cred?: string;
  target?: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}) {
  const token = opts.token === undefined ? SESSION_TOKEN : opts.token;
  return new Request(FORWARD_URL, {
    method: opts.method ?? 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.cred ? { 'x-proteus-proxy-cred': opts.cred } : {}),
      ...(opts.target ? { 'x-proteus-proxy-target': opts.target } : {}),
      'content-type': 'application/json',
      ...opts.headers,
    },
    ...(opts.method === 'GET' ? {} : { body: opts.body ?? '{"model":"x"}' }),
  });
}

interface Upstream { url: string; method: string; headers: Headers; body: string }

function captureUpstream(respond: () => Response): Upstream[] {
  const captured: Upstream[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://models.dev/')) return Response.json(CATALOG);
    captured.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body instanceof ArrayBuffer ? new TextDecoder().decode(init.body) : String(init?.body ?? ''),
    });
    return respond();
  }) as typeof fetch;
  return captured;
}

describe('provider proxy auth gate', () => {
  test('requires a CLI bearer', async () => {
    const env = setupEnv([]);
    const res = await handleCliRequest(forwardRequest({ token: null }), env);
    expect(res?.status).toBe(401);
  });

  test('scoped access tokens need ai.proxy, session tokens always pass', async () => {
    const env = setupEnv([{ key: 'openrouter.bearer', headers: { Authorization: 'Bearer sk-or-real' } }]);
    captureUpstream(() => new Response('ok'));

    const denied = await handleCliRequest(forwardRequest({
      token: READ_TOKEN, cred: 'openrouter.bearer', target: 'https://openrouter.ai/api/v1/chat/completions',
    }), env);
    expect(denied?.status).toBe(403);

    const allowed = await handleCliRequest(forwardRequest({
      token: AI_TOKEN, cred: 'openrouter.bearer', target: 'https://openrouter.ai/api/v1/chat/completions',
    }), env);
    expect(allowed?.status).toBe(200);
  });
});

describe('GET /credentials', () => {
  test('lists proxyable keys with no secret material', async () => {
    const env = setupEnv([
      { key: 'openrouter.bearer', headers: { Authorization: 'Bearer sk-or-real' } },
      { key: 'openai-compat.default', baseURL: 'https://host.example/v1', headers: { Authorization: 'Bearer sk-c' } },
      { key: 'groq.bearer', headers: { Authorization: 'Bearer gsk-real' } },
    ]);
    captureUpstream(() => new Response('unused'));

    const res = await handleCliRequest(new Request(CREDENTIALS_URL, {
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
    }), env);
    const body = await res!.json() as { credentials: Array<{ key: string; baseURL?: string }> };

    expect(body.credentials.map((c) => c.key).sort())
      .toEqual(['groq.bearer', 'openai-compat.default', 'openrouter.bearer']);
    expect(body.credentials.find((c) => c.key === 'openai-compat.default')?.baseURL).toBe('https://host.example/v1');
    expect(JSON.stringify(body)).not.toContain('sk-or-real');
    expect(JSON.stringify(body)).not.toContain('gsk-real');
  });

  test('omits credentials with no derivable endpoint, and the Cloudflare login', async () => {
    const env = setupEnv([
      { key: 'github', headers: { Authorization: 'Bearer ghp' } },
      { key: 'cloudflare.oauth', baseURL: 'https://api.cloudflare.com/client/v4/accounts/a/ai/v1', headers: { authorization: 'Bearer cf' } },
      { key: 'openai.bearer', headers: { Authorization: 'Bearer sk-o' } },
    ]);
    captureUpstream(() => new Response('unused'));

    const res = await handleCliRequest(new Request(CREDENTIALS_URL, {
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
    }), env);
    const body = await res!.json() as { credentials: Array<{ key: string }> };
    expect(body.credentials.map((c) => c.key)).toEqual(['openai.bearer']);
  });
});

describe('POST /forward', () => {
  test('attaches the credential server-side and returns the upstream response', async () => {
    const env = setupEnv([{ key: 'openrouter.bearer', headers: { Authorization: 'Bearer sk-or-real' } }]);
    const seen = captureUpstream(() => Response.json({ ok: true }));

    const res = await handleCliRequest(forwardRequest({
      cred: 'openrouter.bearer',
      target: 'https://openrouter.ai/api/v1/chat/completions',
      body: '{"model":"anthropic/claude"}',
      headers: { 'http-referer': 'https://proteus.example.com' },
    }), env);

    expect(res?.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body).toBe('{"model":"anthropic/claude"}');
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer sk-or-real');
    // Attribution and content headers survive; the proxy's own control
    // headers and the caller's Proteus bearer do not.
    expect(seen[0]?.headers.get('http-referer')).toBe('https://proteus.example.com');
    expect(seen[0]?.headers.get('x-proteus-proxy-cred')).toBeNull();
    expect(seen[0]?.headers.get('x-proteus-proxy-target')).toBeNull();
  });

  test('streams an SSE response through untouched, so usage accounting survives', async () => {
    const env = setupEnv([{ key: 'openai.bearer', headers: { Authorization: 'Bearer sk-real' } }]);
    const chunk = 'data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n';
    captureUpstream(() => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(chunk));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    ));

    const res = await handleCliRequest(forwardRequest({
      cred: 'openai.bearer', target: 'https://api.openai.com/v1/chat/completions',
    }), env);

    expect(res?.headers.get('content-type')).toBe('text/event-stream');
    const text = await res!.text();
    expect(text).toContain('"prompt_tokens":7');
    expect(text).toContain('[DONE]');
  });

  test('refuses a target outside the credential endpoint — the exfiltration case', async () => {
    const env = setupEnv([{ key: 'openai.bearer', headers: { Authorization: 'Bearer sk-real' } }]);
    const seen = captureUpstream(() => new Response('should not happen'));

    const res = await handleCliRequest(forwardRequest({
      cred: 'openai.bearer', target: 'https://attacker.example/v1/chat/completions',
    }), env);

    expect(res?.status).toBe(403);
    expect(seen).toHaveLength(0);
    expect(await res!.text()).toContain('attacker.example');
  });

  test('refuses the Cloudflare login outright', async () => {
    const env = setupEnv([{ key: 'cloudflare.oauth', baseURL: 'https://api.cloudflare.com/client/v4/accounts/a/ai/v1', headers: { authorization: 'Bearer cf' } }]);
    const seen = captureUpstream(() => new Response('should not happen'));

    const res = await handleCliRequest(forwardRequest({
      cred: 'cloudflare.oauth', target: 'https://api.cloudflare.com/client/v4/accounts/a/ai/v1/chat/completions',
    }), env);

    expect(res?.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  test('a credential that is not connected is a 401 naming the key', async () => {
    const env = setupEnv([]);
    captureUpstream(() => new Response('should not happen'));
    const res = await handleCliRequest(forwardRequest({
      cred: 'openai.bearer', target: 'https://api.openai.com/v1/chat/completions',
    }), env);
    expect(res?.status).toBe(401);
    expect(await res!.text()).toContain('openai.bearer');
  });

  test('an unroutable credential key is a 400, not a silent direct send', async () => {
    const env = setupEnv([{ key: 'github', headers: { Authorization: 'Bearer ghp' } }]);
    const seen = captureUpstream(() => new Response('should not happen'));
    const res = await handleCliRequest(forwardRequest({
      cred: 'github', target: 'https://api.github.com/user',
    }), env);
    expect(res?.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  test('a redirect is handed back, never followed with the credential attached', async () => {
    const env = setupEnv([{ key: 'openai.bearer', headers: { Authorization: 'Bearer sk-real' } }]);
    const seen = captureUpstream(() => new Response(null, {
      status: 302, headers: { location: 'https://attacker.example/collect' },
    }));

    const res = await handleCliRequest(forwardRequest({
      cred: 'openai.bearer', target: 'https://api.openai.com/v1/chat/completions',
    }), env);

    expect(res?.status).toBe(302);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(seen.every((s) => !s.url.includes('attacker.example'))).toBe(true);
  });

  test('a target that only looks like the provider is refused', async () => {
    const env = setupEnv([{ key: 'openai.bearer', headers: { Authorization: 'Bearer sk-real' } }]);
    const seen = captureUpstream(() => new Response('should not happen'));
    for (const target of [
      'https://api.openai.com@attacker.example/v1/chat/completions',  // userinfo
      'https://api.openai.com.attacker.example/v1/chat/completions',  // suffix
      'http://api.openai.com/v1/chat/completions',                    // downgrade
      'https://api.openai.com/v1/../admin',                           // traversal
    ]) {
      const res = await handleCliRequest(forwardRequest({ cred: 'openai.bearer', target }), env);
      expect(res?.status).toBe(403);
    }
    expect(seen).toHaveLength(0);
  });

  test('requires both control headers', async () => {
    const env = setupEnv([{ key: 'openai.bearer', headers: { Authorization: 'Bearer sk-real' } }]);
    captureUpstream(() => new Response('should not happen'));
    expect((await handleCliRequest(forwardRequest({ target: 'https://api.openai.com/v1/x' }), env))?.status).toBe(400);
    expect((await handleCliRequest(forwardRequest({ cred: 'openai.bearer' }), env))?.status).toBe(400);
  });
});
