// Accounts: `<base>@<name>` keys, the bare key is `main`, and every call spends one account.
import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import {
  catalogProviderOfKey,
  createProviderRegistry,
  credentialToHeaders,
  formatModelSpec,
  isModelInferenceCredentialKey,
  isProxyDeniedCredentialKey,
  openAICompatNameOf,
  parseModelSpec,
  providerProxyBaseURL,
  specWithoutAccount,
  validateCredentialKey,
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
