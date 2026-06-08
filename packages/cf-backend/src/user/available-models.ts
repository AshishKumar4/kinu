/**
 * Union of models available to a user: Cloudflare OAuth-backed Workers AI +
 * any credential-gated providers they have connected.
 *
 * UserDO knows which credentials exist; this module knows what models each
 * provider exposes. We don't construct any LanguageModel — we just describe
 * the menu for the UI's model picker.
 */
import type { UserDO } from './user-do.js';
import { CLOUDFLARE_OAUTH_CRED_KEY } from '../lib/cloudflare-oauth.js';

export interface ModelMenuEntry {
  /** Full spec — `<provider>/<modelId>`, used as the agent_config.model value. */
  spec: string;
  /** Display label for the picker. */
  label: string;
  /** Provider id (codex, openai, anthropic, workers-ai, …). */
  provider: string;
  /** Capabilities — used by the UI to badge models. */
  capabilities?: string[];
}

const WORKERS_AI_MODELS: ModelMenuEntry[] = [
  { spec: 'workers-ai/@cf/moonshotai/kimi-k2.6',           label: 'Kimi K2.6',         provider: 'workers-ai', capabilities: ['tools', 'streaming'] },
  // MiniMax M3 — 1M-context partner model. Availability and billing still flow
  // through the user's Cloudflare OAuth account.
  { spec: 'workers-ai/minimax/m3',                         label: 'MiniMax M3 (1M ctx · BYOK/balance)', provider: 'workers-ai', capabilities: ['tools', 'streaming', 'reasoning'] },
  { spec: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',     label: 'Llama 4 Scout',     provider: 'workers-ai', capabilities: ['tools', 'streaming'] },
  { spec: 'workers-ai/@cf/meta/llama-4-maverick-17b-128e-instruct', label: 'Llama 4 Maverick',  provider: 'workers-ai', capabilities: ['tools', 'streaming'] },
  { spec: 'workers-ai/@cf/qwen/qwen2.5-coder-32b-instruct',         label: 'Qwen 2.5 Coder',    provider: 'workers-ai', capabilities: ['tools', 'streaming'] },
];

const CODEX_MODELS: ModelMenuEntry[] = [
  { spec: 'codex/gpt-5.5',      label: 'GPT-5.5 (Codex)',      provider: 'codex', capabilities: ['tools', 'streaming', 'reasoning', 'vision'] },
  { spec: 'codex/gpt-5.4',      label: 'GPT-5.4 (Codex)',      provider: 'codex', capabilities: ['tools', 'streaming', 'reasoning', 'vision'] },
  { spec: 'codex/gpt-5.4-mini', label: 'GPT-5.4 mini (Codex)', provider: 'codex', capabilities: ['tools', 'streaming'] },
  { spec: 'codex/gpt-5.3-codex', label: 'GPT-5.3 Codex',       provider: 'codex', capabilities: ['tools', 'streaming', 'reasoning'] },
];

const OPENAI_MODELS: ModelMenuEntry[] = [
  { spec: 'openai/gpt-5',      label: 'GPT-5',      provider: 'openai', capabilities: ['tools', 'streaming', 'reasoning'] },
  { spec: 'openai/gpt-5-mini', label: 'GPT-5 mini', provider: 'openai', capabilities: ['tools', 'streaming'] },
  { spec: 'openai/o3',         label: 'o3',         provider: 'openai', capabilities: ['tools', 'reasoning'] },
];

const ANTHROPIC_MODELS: ModelMenuEntry[] = [
  { spec: 'anthropic/claude-opus-4-7',     label: 'Claude Opus 4.7',  provider: 'anthropic', capabilities: ['tools', 'streaming', 'reasoning', 'vision'] },
  { spec: 'anthropic/claude-sonnet-4-6',   label: 'Claude Sonnet 4.6', provider: 'anthropic', capabilities: ['tools', 'streaming', 'reasoning', 'vision'] },
  { spec: 'anthropic/claude-haiku-4-5',    label: 'Claude Haiku 4.5',  provider: 'anthropic', capabilities: ['tools', 'streaming'] },
];

// OpenRouter has too many models to enumerate. Top picks; users can also
// type any model id manually in the picker.
const OPENROUTER_MODELS: ModelMenuEntry[] = [
  { spec: 'openrouter/anthropic/claude-opus-4-7', label: 'Claude Opus 4.7 (OR)', provider: 'openrouter', capabilities: ['tools', 'streaming', 'reasoning', 'vision'] },
  { spec: 'openrouter/openai/gpt-5',              label: 'GPT-5 (OR)',           provider: 'openrouter', capabilities: ['tools', 'streaming', 'reasoning'] },
  { spec: 'openrouter/google/gemini-3-pro',       label: 'Gemini 3 Pro (OR)',    provider: 'openrouter', capabilities: ['tools', 'streaming', 'reasoning'] },
  { spec: 'openrouter/x-ai/grok-4',               label: 'Grok 4 (OR)',          provider: 'openrouter', capabilities: ['tools', 'streaming'] },
];

export async function listAvailableModels(env: Env, userId: string): Promise<ModelMenuEntry[]> {
  const stub = env.UserDO.get(env.UserDO.idFromName(userId)) as DurableObjectStub<UserDO>;
  const creds = await stub.listCredentials();
  const keys = new Set(creds.map((c) => c.key));

  const out: ModelMenuEntry[] = [];
  if (await stub.getCredentialBaseURL(CLOUDFLARE_OAUTH_CRED_KEY)) out.push(...WORKERS_AI_MODELS);
  if (keys.has('codex.oauth'))      out.push(...CODEX_MODELS);
  if (keys.has('openai.bearer'))    out.push(...OPENAI_MODELS);
  if (keys.has('anthropic.bearer')) out.push(...ANTHROPIC_MODELS);
  if (keys.has('openrouter.bearer'))out.push(...OPENROUTER_MODELS);
  // openai-compat: user-named — we surface each as a single generic entry.
  // The agent_config.model can be set to `openai-compat:<name>/<modelId>`.
  for (const c of creds) {
    if (c.key.startsWith('openai-compat.')) {
      const name = c.key.slice('openai-compat.'.length);
      out.push({
        spec: `openai-compat:${name}/<modelId>`,
        label: `${name} (custom model id)`,
        provider: `openai-compat:${name}`,
        capabilities: ['tools', 'streaming'],
      });
    }
  }
  return out;
}
