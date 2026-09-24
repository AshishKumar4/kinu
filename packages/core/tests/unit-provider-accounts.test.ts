// Accounts: `<base>@<name>` keys, the bare key is `main`, and every call spends one account.
import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import {
  asFetchFunction,
  catalogProviderOfKey,
  creditText,
  readOpenRouterCredit,
  createAnthropicProvider,
  createCodexProvider,
  createOpenAICompatProvider,
  createProviderRegistry,
  quotaWindowText,
  runChat,
  credentialToHeaders,
  formatModelSpec,
  isModelInferenceCredentialKey,
  isProxyDeniedCredentialKey,
  openAICompatNameOf,
  parseModelSpec,
  providerProxyBaseURL,
  specWithoutAccount,
  validateCredentialKey,
  type AuthResolution,
  type ModelProvider,
  type ProviderDeps,
} from '../src/index';

describe('account specs', () => {
  test('an account rides between the provider and the first slash', () => {
    expect(parseModelSpec('anthropic@work/claude-x')).toEqual({ provider: 'anthropic', modelId: 'claude-x', account: 'work' });
    expect(parseModelSpec('openrouter@work/anthropic/claude-x'))
      .toEqual({ provider: 'openrouter', modelId: 'anthropic/claude-x', account: 'work' });
    expect(formatModelSpec(parseModelSpec('openai-compat:box@home/llama'))).toBe('openai-compat:box@home/llama');
  });

  test('a bare Workers AI id is not an account', () => {
    expect(parseModelSpec('@cf/meta/llama-4')).toEqual({ provider: '@cf', modelId: 'meta/llama-4' });
    expect(parseModelSpec('workers-ai/@cf/meta/llama-4').account).toBeUndefined();
  });

  test('a malformed account name is refused, not guessed', () => {
    expect(() => parseModelSpec('anthropic@Work Account/claude-x')).toThrow('not an account name');
    expect(() => parseModelSpec('anthropic@/claude-x')).toThrow('not an account name');
  });

  test('a model menu lists the spec without its account', () => {
    expect(specWithoutAccount('anthropic@work/claude-x')).toBe('anthropic/claude-x');
    expect(specWithoutAccount('anthropic/claude-x')).toBe('anthropic/claude-x');
    expect(specWithoutAccount('@cf/meta/llama-4')).toBe('@cf/meta/llama-4');
  });
});

describe('account credential keys', () => {
  test('an account is its base key plus a name', () => {
    for (const key of ['anthropic.bearer@work', 'codex.oauth@home', 'openai-compat.box@lab-2', 'groq.bearer']) {
      expect(() => validateCredentialKey(key)).not.toThrow();
    }
  });

  test('main is the bare key, Cloudflare is one sign-in, and a name is one plain word', () => {
    expect(() => validateCredentialKey('anthropic.bearer@main')).toThrow('bare key');
    expect(() => validateCredentialKey('cloudflare.oauth@work')).toThrow('one account');
    expect(() => validateCredentialKey('cloudflare.ai-gateway@work')).toThrow('one account');

    for (const key of ['anthropic.bearer@', 'anthropic.bearer@a@b', 'anthropic.bearer@Work', '@work']) {
      expect(() => validateCredentialKey(key)).toThrow();
    }
  });

  test('every account of a proxy-denied key is denied', () => {
    expect(isProxyDeniedCredentialKey('codex.oauth')).toBe(true);
    expect(isProxyDeniedCredentialKey('codex.oauth@x')).toBe(true);
    expect(isProxyDeniedCredentialKey('openai.bearer@x')).toBe(false);
  });

  test('an account keeps its base key\'s authority, no more', () => {
    expect(isModelInferenceCredentialKey('anthropic.bearer@work')).toBe(true);
    expect(isModelInferenceCredentialKey('codex.oauth@work')).toBe(true);
    expect(isModelInferenceCredentialKey('openai-compat.box@work')).toBe(true);
    expect(isModelInferenceCredentialKey('github@work')).toBe(false);
    expect(isModelInferenceCredentialKey('gateway-admin@bearer')).toBe(false);
  });

  test('an account is spent the way its base key is', async () => {
    expect(credentialToHeaders('anthropic.bearer@work', { kind: 'bearer', token: 'sk-ant' }))
      .toEqual({ 'x-api-key': 'sk-ant', 'anthropic-version': '2023-06-01' });
    expect(await providerProxyBaseURL('anthropic.bearer@work', { fetch }))
      .toBe(await providerProxyBaseURL('anthropic.bearer', { fetch }));
    expect(catalogProviderOfKey('groq.bearer@work')).toBe('groq');
    expect(catalogProviderOfKey('github@work')).toBeNull();
    expect(openAICompatNameOf('openai-compat.box@work')).toBe('box');
  });
});

describe('which account a call spends', () => {
  const KEY = 'alpha.bearer';

  function registryWith(stored: readonly string[], accountFor?: (provider: string) => string | undefined) {
    const handed: ProviderDeps[] = [];

    const provider: ModelProvider = {
      id: 'alpha',
      isAvailable: (deps) => deps.hasCredential(KEY),
      unavailableReason: () => 'no alpha key',
      listModels: () => [{ id: 'm' }],
      createModel(modelId, deps) {
        handed.push(deps);

        return new MockLanguageModelV3({ provider: 'alpha', modelId });
      },
    };

    const registry = createProviderRegistry();
    registry.register(provider);

    const deps: ProviderDeps = {
      env: {},
      async getAuth(key) { return stored.includes(key) ? { headers: { authorization: `Bearer ${key}` } } : null; },
      async hasCredential(key) { return stored.includes(key); },
      async listCredentialKeys() { return [...stored]; },
      accountFor,
    };

    const spend = async (spec: string) => {
      registry.resolve(spec, deps);
      const auth = await handed.at(-1)?.getAuth(KEY);

      return auth?.credentialKey ?? null;
    };

    return { registry, deps, spend };
  }

  test('a spec naming an account spends that account', async () => {
    const { spend } = registryWith(['alpha.bearer', 'alpha.bearer@work']);
    expect(await spend('alpha@work/m')).toBe('alpha.bearer@work');
    expect(await spend('alpha@main/m')).toBe('alpha.bearer');
  });

  test('a spec naming none spends the chosen account, else main, else the only one', async () => {
    expect(await registryWith(['alpha.bearer', 'alpha.bearer@work'], () => 'work').spend('alpha/m')).toBe('alpha.bearer@work');
    expect(await registryWith(['alpha.bearer', 'alpha.bearer@work']).spend('alpha/m')).toBe('alpha.bearer');
    expect(await registryWith(['alpha.bearer@work']).spend('alpha/m')).toBe('alpha.bearer@work');
  });

  test('the spec\'s own account wins over the caller\'s choice', async () => {
    const { spend } = registryWith(['alpha.bearer@home', 'alpha.bearer@work'], () => 'work');
    expect(await spend('alpha@home/m')).toBe('alpha.bearer@home');
  });

  test('several accounts, none main and none chosen, is refused by name rather than guessed', async () => {
    const { spend, registry, deps } = registryWith(['alpha.bearer@home', 'alpha.bearer@work']);
    await expect(spend('alpha/m')).rejects.toThrow('alpha has the accounts home, work and no default');
    const listed = (await registry.listProviders(deps)).find((p) => p.id === 'alpha');
    expect(listed?.available).toBe(false);
    expect(listed?.unavailableReason).toContain('no default');
  });

  test('a chosen account that is not connected names the account', async () => {
    const { spend, registry, deps } = registryWith(['alpha.bearer'], () => 'work');
    await expect(spend('alpha/m')).rejects.toThrow('No usable alpha credential for the account "work"');
    expect((await registry.listProviders(deps)).find((p) => p.id === 'alpha')?.available).toBe(false);
  });
});

describe('what a call tells the ledger about its account', () => {
  test('a turn\'s step names the account its key paid from and the quota that response reported', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''), {
        headers: {
          'content-type': 'text/event-stream',
          date: 'Wed, 23 Sep 2026 10:00:00 GMT',
          'x-ratelimit-limit-requests': '60',
          'x-ratelimit-remaining-requests': '59',
          'x-ratelimit-reset-requests': '1s',
          'x-ratelimit-limit-tokens': '150000',
          'x-ratelimit-remaining-tokens': '149984',
          'x-ratelimit-reset-tokens': '6m0s',
        },
      }),
    });

    const deps: ProviderDeps = {
      env: {},
      async getAuth(key) {
        return key === 'openai-compat.default@work'
          ? { headers: { Authorization: 'Bearer key-work' }, baseURL: `http://localhost:${String(server.port)}/v1` }
          : null;
      },
      async hasCredential(key) { return key === 'openai-compat.default@work'; },
      async listCredentialKeys() { return ['openai-compat.default@work']; },
      accountFor: () => 'work',
    };

    const registry = createProviderRegistry();
    registry.register(createOpenAICompatProvider());
    const steps = [];

    try {
      for await (const event of runChat({
        model: registry.resolve('openai-compat/m', deps), system: 'sys', history: [{ role: 'user', content: 'go' }], tools: {},
      })) {
        if (event.type === 'step-finish') steps.push(event.account);
      }
    } finally {
      await server.stop(true);
    }

    const at = Date.parse('Wed, 23 Sep 2026 10:00:00 GMT');
    expect(steps).toEqual([{
      provider: 'openai-compat',
      name: 'work',
      quota: {
        at,
        windows: [
          { measure: 'requests', limit: 60, remaining: 59, resetsAt: at + 1_000 },
          { measure: 'tokens', limit: 150_000, remaining: 149_984, resetsAt: at + 360_000 },
        ],
      },
    }]);
  });

  /** One turn on `spec` whose every response carries `headers`; the step's recorded account. */
  async function accountOfTurn(spec: string, stored: Record<string, AuthResolution>, body: string, headers: Record<string, string>) {
    const registry = createProviderRegistry();
    registry.register(createAnthropicProvider());
    registry.register(createCodexProvider());

    const deps: ProviderDeps = {
      env: {},
      fetch: asFetchFunction(async () => new Response(body, { headers: { 'content-type': 'text/event-stream', ...headers } })),
      async getAuth(key) { return stored[key] ?? null; },
      async hasCredential(key) { return key in stored; },
      async listCredentialKeys() { return Object.keys(stored); },
    };

    for await (const event of runChat({ model: registry.resolve(spec, deps), system: 'sys', history: [{ role: 'user', content: 'go' }], tools: {} })) {
      if (event.type === 'step-finish') return event.account;
    }

    return undefined;
  }

  const sse = (frames: ReadonlyArray<readonly [string, object]>): string => frames
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

  test('Anthropic\'s rate-limit headers read as its windows (docs.anthropic.com/en/api/rate-limits)', async () => {
    const body = sse([
      ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-x', content: [], usage: { input_tokens: 5, output_tokens: 0 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
      ['message_stop', { type: 'message_stop' }],
    ]);

    const account = await accountOfTurn('anthropic@work/claude-x', { 'anthropic.bearer@work': { headers: { 'x-api-key': 'sk-work' } } }, body, {
      date: 'Wed, 23 Sep 2026 10:00:00 GMT',
      'anthropic-ratelimit-requests-limit': '50',
      'anthropic-ratelimit-requests-remaining': '49',
      'anthropic-ratelimit-requests-reset': '2026-09-23T10:00:30Z',
      'anthropic-ratelimit-input-tokens-limit': '40000',
      'anthropic-ratelimit-input-tokens-remaining': '39995',
      'anthropic-ratelimit-input-tokens-reset': '2026-09-23T10:00:01Z',
    });

    expect(account).toEqual({
      provider: 'anthropic',
      name: 'work',
      quota: {
        at: Date.parse('2026-09-23T10:00:00Z'),
        windows: [
          { measure: 'requests', limit: 50, remaining: 49, resetsAt: Date.parse('2026-09-23T10:00:30Z') },
          { measure: 'input-tokens', limit: 40_000, remaining: 39_995, resetsAt: Date.parse('2026-09-23T10:00:01Z') },
        ],
      },
    });
  });

  test('a ChatGPT plan reads as its windows, as the open-source Codex CLI reads the `x-codex-*` headers', async () => {
    const body = sse([
      ['response.created', { type: 'response.created', response: { id: 'r', created_at: 1_700_000_000, model: 'gpt-5.5' } }],
      ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg' } }],
      ['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg', delta: 'ok' }],
      ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg' } }],
      ['response.completed', { type: 'response.completed', response: { incomplete_details: null, usage: { input_tokens: 5, output_tokens: 1 } } }],
    ]);

    const account = await accountOfTurn('codex@home/gpt-5.5', { 'codex.oauth@home': { headers: { Authorization: 'Bearer codex-home' } } }, body, {
      date: 'Wed, 23 Sep 2026 10:00:00 GMT',
      'x-codex-primary-used-percent': '41',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': String(Date.parse('2026-09-23T12:03:00Z') / 1_000),
      'x-codex-secondary-used-percent': '12',
      'x-codex-secondary-window-minutes': '10080',
    });

    expect(account).toEqual({
      provider: 'codex',
      name: 'home',
      quota: {
        at: Date.parse('2026-09-23T10:00:00Z'),
        windows: [
          { measure: '300m', usedPercent: 41, resetsAt: Date.parse('2026-09-23T12:03:00Z') },
          { measure: '10080m', usedPercent: 12 },
        ],
      },
    });
  });

  test('a quota reads the same on every surface, and a window that has passed says it reset', () => {
    const now = Date.parse('2026-09-23T10:00:00Z');

    expect(quotaWindowText({ measure: 'input-tokens', limit: 40_000, remaining: 31_200, resetsAt: now + 22_000 }, now))
      .toBe('31.2k of 40k input tokens left, resets in 22s');
    expect(quotaWindowText({ measure: '300m', usedPercent: 41.4, resetsAt: now + 7_380_000 }, now))
      .toBe('41% of the 5h window used, resets in 2h 3m');
    expect(quotaWindowText({ measure: 'requests', remaining: 3, resetsAt: now - 1 }, now)).toBe('3 requests left, window reset since');
  });
});

describe('what an OpenRouter key has left', () => {
  const keyInfo = (data: Readonly<Record<string, number | string | null>>, status = 200) => asFetchFunction(async () => Response.json({ data }, { status }));

  test('a key with a credit limit says what is left of it and when it resets', async () => {
    const credit = await readOpenRouterCredit({
      account: 'work',
      headers: { Authorization: 'Bearer sk-or-work' },
      fetch: keyInfo({ label: 'work', limit: 10, limit_remaining: 4.12, limit_reset: 'monthly', usage: 30, usage_daily: 1.03, usage_monthly: 5.88 }),
    });

    expect(creditText(credit)).toBe('$4.12 of $10.00 left, resets monthly; $1.03 used today, $5.88 this month');
  });

  test('a key without a limit says so rather than a balance it does not have', async () => {
    const credit = await readOpenRouterCredit({
      account: 'main',
      headers: { Authorization: 'Bearer sk-or-main' },
      fetch: keyInfo({ label: 'main', limit: null, limit_remaining: null, usage: 3, usage_daily: 0, usage_monthly: 0.5 }),
    });

    expect(creditText(credit)).toBe('no credit limit on this key; $0 used today, $0.500 this month');
  });

  test('a refused key is an error naming its account, never zero credit', async () => {
    await expect(readOpenRouterCredit({ account: 'team', headers: {}, fetch: keyInfo({}, 401) }))
      .rejects.toThrow('OpenRouter answered HTTP 401 for the team key');
  });
});
