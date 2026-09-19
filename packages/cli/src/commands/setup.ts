import { DEFAULT_WORKERS_AI_MODEL_SPEC } from '@kinu.run/core';
import { checkClaudeAvailability } from '@kinu.run/cli-backend';
import { loadConfigFile, setDefaultModel, updateConfigFile } from '../config';
import { ACCENT, DIM, OK, WARN } from '../display';
import { ask, askSecret, canPrompt, confirm } from '../prompt';
import { authCommand } from './auth';
import {
  connectProvider,
  PROVIDER_CONNECTORS,
  type ProviderConnectId,
  type ProviderConnectOutcome,
  type ProviderConnectPort,
} from './provider-connect';

/**
 * The console side of a provider connect: progress in the dim register, one
 * question at a time through the CLI's own prompt. The flows themselves live
 * in `provider-connect.ts`, where the TUI reaches the same code with a port
 * of its own.
 */
function consoleProviderPort(): ProviderConnectPort {
  return {
    report: (line) => console.log(DIM(line)),
    ask: async (request) => (request.secret === true
      ? await askSecret(request.label, request.fallback)
      : await ask(request.label, request.fallback)),
  };
}

/** The flags a connect flow reads, with the absent ones left absent rather
 *  than handed over as undefined. */
export function connectOptions(opts: {
  readonly origin?: string;
  readonly model?: string;
  readonly local?: boolean;
}): { readonly origin?: string; readonly model?: string; readonly local: boolean } {
  const base = { local: opts.local ?? false };
  const withOrigin = opts.origin === undefined ? base : { ...base, origin: opts.origin };

  return opts.model === undefined ? withOrigin : { ...withOrigin, model: opts.model };
}

/** Run one provider's flow with the console port, and say how it ended. */
export async function connectProviderOnConsole(
  id: ProviderConnectId,
  opts: { readonly origin?: string; readonly model?: string; readonly local?: boolean } = {},
): Promise<ProviderConnectOutcome> {
  const descriptor = PROVIDER_CONNECTORS.find((candidate) => candidate.id === id);

  if (descriptor === undefined) throw new Error(`Unknown provider: ${id}`);
  console.log('');
  console.log(ACCENT(descriptor.label));
  console.log(DIM(descriptor.blurb));
  const outcome = await connectProvider(id, consoleProviderPort(), opts);

  if (outcome.kind === 'connected') {
    console.log(`${OK('✓')} ${outcome.summary}`);

    if (outcome.detail !== undefined) console.log(DIM(outcome.detail));
  } else {
    console.log(`${WARN('!')} ${outcome.reason}`);
    console.log(DIM(outcome.hint));
  }

  return outcome;
}

/** Everything the setup preflight reads: the command flags and whether the
 *  account is signed in. */
interface SetupPreflightContext {
  readonly opts: {
    readonly origin?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly yes?: boolean;
    readonly skipCloud?: boolean;
    readonly localModel?: boolean;
    readonly accountOnly?: boolean;
    readonly local?: boolean;
  };
  readonly cloudReady: boolean;
}

/** Account-only and non-interactive early exits. Answers 'handled' when setup
 *  ends here and 'continue' when provider setup runs next. */
async function runSetupPreflight(ctx: SetupPreflightContext): Promise<'handled' | 'continue'> {
  if (ctx.opts.accountOnly) {
    if (ctx.cloudReady) {
      console.log(`${OK('✓')} Kinu account ready.`);
      console.log(DIM('Cloud workspaces can use Workers AI through your Cloudflare account, if you granted AI permissions at sign-in.'));
      console.log(DIM('Run kinu provider connect codex for local workspaces that should use your ChatGPT Codex subscription.'));
    } else {
      console.log(`${WARN('!')} Kinu account was not connected.`);
      console.log(DIM(`Run kinu auth${ctx.opts.origin ? ` --origin ${ctx.opts.origin}` : ''} when you are ready.`));
    }

    return 'handled';
  }

  if (!ctx.opts.yes && !ctx.opts.provider && !ctx.opts.localModel && !canPrompt()) {
    if (ctx.cloudReady) {
      console.log(`${OK('✓')} Kinu account ready.`);
      console.log(DIM('Workers AI uses the Cloudflare account you signed in with.'));
    } else {
      console.log(`${WARN('!')} Kinu account was not connected (no interactive terminal).`);
      console.log(DIM(`Run kinu auth${ctx.opts.origin ? ` --origin ${ctx.opts.origin}` : ''} when you are ready.`));
    }

    console.log(DIM('Run kinu provider connect <provider> to configure local workspace model access.'));

    return 'handled';
  }

  return 'continue';
}

export async function setupCommand(opts: {
  origin?: string;
  provider?: string;
  model?: string;
  yes?: boolean;
  skipCloud?: boolean;
  localModel?: boolean;
  accountOnly?: boolean;
  /** Keep the provider secret on this machine instead of the account. */
  local?: boolean;
}): Promise<void> {
  console.log('');
  console.log(ACCENT('Kinu setup'));
  console.log(DIM('Connect your account, Cloudflare Workers AI billing, and optional local providers.'));
  console.log('');

  const config = loadConfigFile();
  let cloudReady = Boolean(config.accessToken);

  if (cloudReady) {
    console.log(`${OK('✓')} Signed in${config.user?.email ? ` as ${ACCENT(config.user.email)}` : ''}`);
    console.log(DIM('While you are signed in, new local workspaces run on your Cloudflare account via Workers AI. No API key on this machine.'));
  }

  if (!opts.skipCloud && !config.accessToken) {
    // Without a terminal there is nothing to ask — fall through to the
    // honest instruction paths below instead of letting readline hang on
    // a pipe (the `curl | bash` installer freeze).
    const shouldLogin = opts.yes || (canPrompt() && await confirm('Sign in and attach Cloudflare Workers AI permissions now?', true));

    if (shouldLogin) {
      await authCommand({ origin: opts.origin });
      cloudReady = Boolean(loadConfigFile().accessToken);
    }
  }

  if (await runSetupPreflight({ opts, cloudReady }) === 'handled') return;

  const provider = normalizeProvider(opts.provider ?? (opts.yes ? 'workers-ai' : await chooseProvider(cloudReady)));

  if (provider === 'skip') {
    console.log(`${WARN('!')} Skipped local model setup.`);
    console.log(DIM(cloudReady
      ? 'Cloud workspaces remain ready. Run kinu provider connect <provider> later for local workspaces.'
      : 'Run kinu setup later before creating workspaces.'));

    return;
  }

  if (provider === 'workers-ai') {
    if (!cloudReady) {
      console.log(`${WARN('!')} Workers AI needs a signed-in Kinu account.`);
      console.log(DIM(`Run kinu auth${opts.origin ? ` --origin ${opts.origin}` : ''}, then kinu setup again.`));

      return;
    }

    if (opts.model) {
      const spec = `workers-ai/${stripProviderPrefix(opts.model, 'workers-ai')}`;
      setDefaultModel(spec);
      console.log(`${OK('✓')} Using Cloudflare Workers AI`);
      console.log(DIM(`Default model: ${spec}`));

      return;
    }

    // Storing nothing is deliberate: the platform default is one constant in
    // @kinu.run/core, and an unset model reads it at resolve time instead of
    // pinning a copy that would go stale.
    updateConfigFile((config) => { delete config.model; });
    console.log(`${OK('✓')} Using Cloudflare Workers AI`);
    console.log(DIM(`Default model: ${DEFAULT_WORKERS_AI_MODEL_SPEC}`));
    console.log(DIM('No API key on this machine. Requests go through your Kinu account.'));

    return;
  }

  await connectProviderOnConsole(provider, connectOptions(opts));
}

async function chooseProvider(cloudReady: boolean): Promise<string> {
  console.log(DIM('Local model provider:'));
  console.log(`  ${ACCENT('1')} Cloudflare Workers AI through your Kinu account ${DIM('(recommended)')}`);
  console.log(`  ${ACCENT('2')} ChatGPT Codex subscription`);
  console.log(`  ${ACCENT('3')} OpenAI API key`);
  console.log(`  ${ACCENT('4')} OpenRouter`);
  console.log(`  ${ACCENT('5')} Anthropic`);
  console.log(`  ${ACCENT('6')} OpenAI-compatible`);
  console.log(`  ${ACCENT('7')} OpenCode (share your opencode auth & models)`);
  console.log(`  ${ACCENT('8')} Skip`);

  if (!cloudReady) console.log(DIM('  Option 1 needs a signed-in account. Run kinu auth first.'));

  // No-friction discovery: the Claude Code subscription stores no credential
  // here (the binary owns its own login), so mention it inline rather than as a
  // step — only when it is actually usable on this machine.
  if ((await checkClaudeAvailability()).loggedIn) {
    console.log(DIM('  Claude Code detected. Or use --model claude/claude-opus-4-x for your subscription.'));
  }

  const value = await ask('Choice', '1');

  return value;
}

/**
 * The aliases users type on either surface, folded onto one canonical name.
 * Both `kinu setup --provider` and `kinu provider connect` resolve through
 * this map, so an alias learned on one surface works on the other. Menu
 * positions ('1'-'8') are not aliases: the interactive prompt owns those, so
 * they never reach this map. Unknown tokens pass through for the caller to
 * reject with its own usage text.
 */
export function canonicalProviderName(value: string): string {
  const token = value.trim().toLowerCase();

  switch (token) {
    case 'cf':
    case 'workers-ai':
    case 'workersai':
    case 'account':
      return 'cloudflare';
    case 'claude-code':
    case 'subscription':
    case 'claude-subscription':
    case 'claude':
      return 'claude';
    case 'chatgpt':
    case 'chatgpt-codex':
      return 'codex';
    case 'compat':
    case 'ollama':
      return 'openai-compatible';
    default:
      return token;
  }
}

function normalizeProvider(value: string): 'workers-ai' | 'claude' | 'codex' | 'openai' | 'openrouter' | 'anthropic' | 'openai-compatible' | 'opencode' | 'skip' {
  const v = value.trim().toLowerCase();

  // Menu positions on the --provider flag. The prompt resolves these same
  // answers interactively; the flag keeps accepting them, pinned by
  // setup-default-provider.test.ts which cannot drive the prompt headlessly.
  if (v === '1') return 'workers-ai';

  if (v === '2') return 'codex';

  if (v === '3') return 'openai';

  if (v === '4') return 'openrouter';

  if (v === '5') return 'anthropic';

  if (v === '6') return 'openai-compatible';

  if (v === '7') return 'opencode';

  if (v === '8' || v === 'skip' || v === 'none') return 'skip';

  // Anything else is a name, resolved through the one alias map. `cloudflare`
  // is this command's `workers-ai` branch; bare `claude` is the subscription,
  // not the Anthropic API key one position down the menu.
  switch (canonicalProviderName(value)) {
    case 'cloudflare': return 'workers-ai';
    case 'claude': return 'claude';
    case 'codex': return 'codex';
    case 'openai': return 'openai';
    case 'openrouter': return 'openrouter';
    case 'anthropic': return 'anthropic';
    case 'openai-compatible': return 'openai-compatible';
    case 'opencode': return 'opencode';
    default:
      throw new Error('Provider must be workers-ai, codex, openai, openrouter, anthropic, openai-compatible, opencode, or skip.');
  }
}

function stripProviderPrefix(model: string, provider: string): string {
  return model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
}
