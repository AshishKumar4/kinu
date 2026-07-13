import { checkClaudeAvailability, checkOpenCodeAvailability } from '@proteus/cli-backend';
import { loadConfigFile } from '../config.js';
import { ACCENT, DIM, OK, WARN } from '../display.js';
import { authCommand } from './auth.js';
import { setupCommand } from './setup.js';

type ProviderAction = 'list' | 'connect';
type ProviderName =
  | 'cloudflare'
  | 'claude'
  | 'codex'
  | 'openai'
  | 'openrouter'
  | 'anthropic'
  | 'openai-compatible'
  | 'opencode';

const PROVIDERS = new Set<ProviderName>([
  'cloudflare',
  'claude',
  'codex',
  'openai',
  'openrouter',
  'anthropic',
  'openai-compatible',
  'opencode',
]);

const CLAUDE_INSTALL_HINT = 'Install Claude Code: https://docs.claude.com/en/docs/claude-code/setup';
const CLAUDE_LOGIN_HINT = 'Run `claude` once to sign in to your Claude subscription.';
const CLAUDE_READY = 'Claude subscription ready — use proteus create --model claude/claude-opus-4-x';

export async function providersCommand(actionOrProvider: string | undefined, providerArg: string | undefined, opts: {
  origin?: string;
  model?: string;
}): Promise<void> {
  const { action, provider } = parseArgs(actionOrProvider, providerArg);

  if (action === 'list') {
    await printProviders();
    return;
  }

  if (!provider) {
    throw new Error('Choose a provider to connect: cloudflare, claude, codex, openai, openrouter, anthropic, openai-compatible, or opencode.');
  }

  if (provider === 'cloudflare') {
    console.log('');
    console.log(ACCENT('Connect Cloudflare'));
    console.log(DIM('Browser sign-in attaches your Cloudflare account for Workers AI and AI Gateway usage.'));
    console.log(DIM('The OAuth consent must include User Details, Account Settings, Workers AI, and AI Gateway scopes.'));
    await authCommand({ origin: opts.origin });
    return;
  }

  if (provider === 'claude') {
    await connectClaude();
    return;
  }

  if (provider === 'opencode') {
    await connectOpenCode(opts);
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

/** Claude subscription "connect" is a status check, not a credential we store:
 *  the official `claude` binary owns its own Claude Code login. We probe PATH +
 *  `claude auth status` and print the next step. LOCAL ONLY — cloud agents need
 *  an Anthropic API key (proteus provider connect anthropic), not this. */
async function connectClaude(): Promise<void> {
  console.log('');
  console.log(ACCENT('Claude subscription (via Claude Code)'));
  console.log(DIM('Drives the official `claude` binary with your Claude Code login. Local workspaces only.'));
  const { binary, loggedIn } = await checkClaudeAvailability();
  console.log('');
  if (binary && loggedIn) {
    console.log(`${OK('✓')} ${CLAUDE_READY}`);
  } else if (binary) {
    console.log(`${WARN('!')} ${CLAUDE_LOGIN_HINT}`);
  } else {
    console.log(`${WARN('!')} ${CLAUDE_INSTALL_HINT}`);
    console.log(DIM('Then run `claude` once to sign in.'));
  }
  console.log(DIM('Cloud workspaces cannot use the subscription — connect an Anthropic API key for those.'));
}

/** opencode bridge "connect" — probes the local opencode CLI for
 *  availability and delegates to the full setup flow which reads auth.json,
 *  discovers models, and writes the model spec. */
async function connectOpenCode(opts: { model?: string }): Promise<void> {
  console.log('');
  console.log(ACCENT('OpenCode (shared auth)'));
  console.log(DIM('Reuses the model providers and auth tokens from your local opencode CLI.'));
  const avail = await checkOpenCodeAvailability();
  console.log('');
  if (avail.binary && avail.authenticated) {
    console.log(`${OK('✓')} opencode detected and authenticated`);
    console.log(DIM('Run `proteus provider connect opencode` to configure, or `proteus setup --provider opencode`.'));
    // Delegate to the full setup flow for model discovery + config write.
    await setupCommand({ provider: 'opencode', model: opts.model, localModel: true, skipCloud: true });
  } else if (avail.binary) {
    console.log(`${WARN('!')} opencode found but not authenticated.`);
    console.log(DIM(LOGIN_HINT_OPENCODE));
  } else {
    console.log(`${WARN('!')} opencode CLI not found.`);
    console.log(DIM(INSTALL_HINT_OPENCODE));
  }
  console.log(DIM('Cloud agents cannot use opencode — they need their own provider credentials.'));
}

const INSTALL_HINT_OPENCODE = 'Install opencode: https://opencode.ai';
const LOGIN_HINT_OPENCODE = 'Run `opencode auth login` to authenticate opencode, then run `proteus setup` again.';

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
      : v === 'claude-code' || v === 'subscription' || v === 'claude-subscription'
        ? 'claude'
        : v === 'chatgpt' || v === 'chatgpt-codex'
          ? 'codex'
          : v === 'compat' || v === 'ollama'
            ? 'openai-compatible'
            : v === 'opencode' ? 'opencode'
            : v;

  if (PROVIDERS.has(provider as ProviderName)) return provider as ProviderName;
  throw new Error('Provider must be cloudflare, claude, codex, openai, openrouter, anthropic, openai-compatible, or opencode.');
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

async function printProviders(): Promise<void> {
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
    console.log(`    ${DIM('Cloud workspaces use your Cloudflare Workers AI quota when Cloudflare sign-in granted AI permissions.')}`);
    console.log(`    ${DIM('Signed-in local workspaces also get free Workers AI (no key) through the proxy.')}`);
  } else {
    missing('Proteus account', 'proteus provider connect cloudflare');
  }

  const claude = await checkClaudeAvailability();
  if (claude.binary && claude.loggedIn) connected('Claude subscription', 'claude/claude-opus-4-x');
  else if (claude.binary) missing('Claude subscription', CLAUDE_LOGIN_HINT);
  else missing('Claude subscription', 'proteus provider connect claude');

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

  const oc = await checkOpenCodeAvailability();
  if (oc.binary && oc.authenticated) connected('OpenCode', currentModel(config.model, 'opencode'));
  else if (oc.binary) missing('OpenCode', LOGIN_HINT_OPENCODE);
  else missing('OpenCode', 'proteus provider connect opencode');

  console.log('');
}

function currentModel(model: string | undefined, prefix: string): string | undefined {
  if (!model?.startsWith(`${prefix}/`)) return undefined;
  return model.slice(prefix.length + 1);
}


