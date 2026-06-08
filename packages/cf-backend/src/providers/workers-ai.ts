// Workers AI provider — uses the logged-in user's Cloudflare OAuth credential.
// The model is constructed synchronously; the account-scoped base URL and
// bearer token are resolved from UserDO inside customFetch on each request.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ModelProvider, ModelInfo } from '@proteus/core';
import { asFetchFunction } from '@proteus/core';
import { CLOUDFLARE_OAUTH_CRED_KEY } from '../lib/cloudflare-oauth.js';

const MODELS: ModelInfo[] = [
  { id: '@cf/moonshotai/kimi-k2.6',                       label: 'Kimi K2.6',            capabilities: ['tools', 'streaming'] },
  // Partner model via the binding's gateway route — needs BYOK/balance (not free).
  { id: 'minimax/m3',                                     label: 'MiniMax M3 (1M ctx)',  capabilities: ['tools', 'streaming', 'reasoning'] },
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct',        label: 'Llama 4 Scout',        capabilities: ['tools', 'streaming', 'vision'] },
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',       label: 'Llama 3.3 70B (fast)', capabilities: ['tools', 'streaming'] },
  { id: '@cf/openai/gpt-oss-120b',                        label: 'GPT-OSS 120B',         capabilities: ['tools', 'streaming'] },
  { id: '@cf/openai/gpt-oss-20b',                         label: 'GPT-OSS 20B',          capabilities: ['tools', 'streaming'] },
  { id: '@cf/qwen/qwen2.5-coder-32b-instruct',            label: 'Qwen 2.5 Coder 32B',   capabilities: ['tools', 'streaming'] },
  { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',   label: 'DeepSeek R1 Distill',  capabilities: ['streaming', 'reasoning'] },
];

export interface WorkersAIOptions {
  /** Prefix-cache affinity key — routes same-key requests to the same replica. */
  sessionAffinity?: string;
}

/** Stable per-agent Workers AI session-affinity key — pins an agent's turns to
 *  the same replica so the (default-on) prefix cache actually hits across turns.
 *  Same `proteus-<name>` scheme as the sandbox id; one source so the 5 registry
 *  call sites don't drift. */
export function agentAffinityKey(name: string): string {
  return `proteus-${name}`;
}

export function createWorkersAIProvider(_opts: WorkersAIOptions = {}): ModelProvider {
  return {
    id: 'workers-ai',
    label: 'Cloudflare Workers AI',
    defaultModel: '@cf/moonshotai/kimi-k2.6',
    async isAvailable(deps) {
      const auth = await deps.getAuth(CLOUDFLARE_OAUTH_CRED_KEY);
      return !!auth?.baseURL;
    },
    unavailableReason: () => 'Cloudflare OAuth login is required for Workers AI billing.',
    listModels: () => MODELS,
    createModel(modelId, deps): LanguageModel {
      const baseFetch = deps.fetch ?? fetch;
      const placeholder = 'https://proteus-workers-ai.invalid';
      const customFetch = asFetchFunction(async (input, init) => {
        const auth = await deps.getAuth(CLOUDFLARE_OAUTH_CRED_KEY);
        if (!auth?.baseURL) {
          return new Response(
            JSON.stringify({ error: 'Cloudflare login is required before using Workers AI models.' }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          );
        }

        const headers = new Headers(init?.headers);
        for (const [key, value] of Object.entries(auth.headers)) headers.set(key, value);
        const originalUrl = typeof input === 'string' ? input
          : input instanceof URL ? input.toString()
            : input.url;
        const url = originalUrl.startsWith(placeholder)
          ? auth.baseURL.replace(/\/+$/, '') + originalUrl.slice(placeholder.length)
          : originalUrl;
        return baseFetch(url, { ...init, headers });
      });

      return createOpenAICompatible({
        name: 'workers-ai',
        baseURL: placeholder,
        fetch: customFetch,
      }).chatModel(modelId);
    },
  };
}
