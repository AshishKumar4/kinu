import { loadConfigFile } from '../config.js';
import { ACCENT, DIM, OK, WARN } from '../display.js';
import { authCommand } from './auth.js';
import { setupCommand } from './setup.js';

type ProviderAction = 'list' | 'connect';
type ProviderName =
  | 'cloudflare'
  | 'codex'
  | 'openai'
  | 'openrouter'
  | 'anthropic'
  | 'openai-compatible';

const PROVIDERS = new Set<ProviderName>([
  'cloudflare',
  'codex',
  'openai',
  'openrouter',
  'anthropic',
  'openai-compatible',
]);

export async function providersCommand(actionOrProvider: string | undefined, providerArg: string | undefined, opts: {
  origin?: string;
  model?: string;
}): Promise<void> {
  const { action, provider } = parseArgs(actionOrProvider, providerArg);

  if (action === 'list') {
    printProviders();
    return;
  }

  if (!provider) {
    throw new Error('Choose a provider to connect: cloudflare, codex, openai, openrouter, anthropic, or openai-compatible.');
  }

  if (provider === 'cloudflare') {
    console.log('');
    console.log(ACCENT('Connect Cloudflare'));
    console.log(DIM('Browser sign-in attaches your Cloudflare account for Workers AI and AI Gateway usage.'));
    console.log(DIM('The OAuth consent must include User Details, Account Settings, Workers AI, and AI Gateway scopes.'));
    await authCommand({ origin: opts.origin });
    return;
  }

  await setupCommand({
    origin: opts.origin,
    provider,
    model: opts.model,
    localModel: true,
    skipCloud: true,
  });
}

function parseArgs(actionOrProvider: string | undefined, providerArg: string | undefined): {
  action: ProviderAction;
  provider?: ProviderName;
} {
  if (!actionOrProvider) return { action: 'list' };

  const first = normalizeToken(actionOrProvider);
  if (first === 'list' || first === 'ls' || first === 'status') return { action: 'list' };

  if (first === 'connect' || first === 'login' || first === 'add') {
    return { action: 'connect', provider: providerArg ? normalizeProvider(providerArg) : undefined };
  }

  return { action: 'connect', provider: normalizeProvider(actionOrProvider) };
}

function normalizeProvider(value: string): ProviderName {
  const v = normalizeToken(value);
  const provider =
    v === 'cf' || v === 'workers-ai' || v === 'account'
      ? 'cloudflare'
      : v === 'chatgpt' || v === 'chatgpt-codex'
        ? 'codex'
        : v === 'compat' || v === 'ollama'
          ? 'openai-compatible'
          : v;

  if (PROVIDERS.has(provider as ProviderName)) return provider as ProviderName;
  throw new Error('Provider must be cloudflare, codex, openai, openrouter, anthropic, or openai-compatible.');
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function printProviders(): void {
  const config = loadConfigFile();
  const connected = (label: string, detail?: string) => {
    console.log(`  ${OK('✓')} ${ACCENT(label)}${detail ? ` ${DIM(detail)}` : ''}`);
  };
  const missing = (label: string, hint: string) => {
    console.log(`  ${WARN('!')} ${label} ${DIM(hint)}`);
  };

  console.log('');
  console.log(ACCENT('Proteus providers'));
  console.log('');

  if (config.accessToken) {
    connected('Proteus account', config.user?.email);
    console.log(`    ${DIM('Cloud agents use your Cloudflare Workers AI quota when Cloudflare sign-in granted AI permissions.')}`);
  } else {
    missing('Proteus account', 'proteus provider connect cloudflare');
  }

  const providers = config.providers ?? {};
  if (providers.codex?.accessToken || providers.codex?.refreshToken) connected('Codex', currentModel(config.model, 'codex'));
  else missing('Codex', 'proteus provider connect codex');

  if (providers.openai?.apiKey) connected('OpenAI', currentModel(config.model, 'openai'));
  else missing('OpenAI', 'proteus provider connect openai');

  if (providers.openrouter?.apiKey) connected('OpenRouter', currentModel(config.model, 'openrouter'));
  else missing('OpenRouter', 'proteus provider connect openrouter');

  if (providers.anthropic?.apiKey) connected('Anthropic', currentModel(config.model, 'anthropic'));
  else missing('Anthropic', 'proteus provider connect anthropic');

  if (providers.openaiCompat?.default) connected('OpenAI-compatible', currentModel(config.model, 'openai-compat'));
  else missing('OpenAI-compatible', 'proteus provider connect openai-compatible');

  console.log('');
}

function currentModel(model: string | undefined, prefix: string): string | undefined {
  if (!model?.startsWith(`${prefix}/`)) return undefined;
  return model.slice(prefix.length + 1);
}
