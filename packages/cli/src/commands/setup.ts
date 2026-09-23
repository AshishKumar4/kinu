import { DEFAULT_WORKERS_AI_MODEL_SPEC } from '@kinu.run/core';
import { checkClaudeAvailability, stripProvider } from '@kinu.run/cli-backend';
import { loadConfigFile } from '../config';
import { adoptDefaultModel } from '../default-model';
import { ACCENT, DIM, OK, WARN } from '../display';
import { ask, askSecret, canPrompt, confirm, skippableOnEnter } from '../prompt';
import { authCommand } from './auth';
import {
  connectProvider,
  PROVIDER_CONNECTORS,
  type ProviderConnectId,
  type ProviderConnectOutcome,
  type ProviderConnectPort,
} from './provider-connect';

function consoleProviderPort(): ProviderConnectPort {
  return {
    report: (line) => console.log(DIM(line)),
    ask: async (request) => (request.secret === true
      ? await askSecret(request.label, request.fallback)
      : await ask(request.label, request.fallback)),
    skippable: skippableOnEnter,
  };
}

export function connectOptions(opts: {
  readonly origin?: string;
  readonly model?: string;
  readonly local?: boolean;
}): { readonly origin?: string; readonly model?: string; readonly local: boolean } {
  const base = { local: opts.local ?? false };
  const withOrigin = opts.origin === undefined ? base : { ...base, origin: opts.origin };

  return opts.model === undefined ? withOrigin : { ...withOrigin, model: opts.model };
}

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

async function runSetupPreflight(ctx: SetupPreflightContext): Promise<'handled' | 'continue'> {
  if (ctx.opts.accountOnly) {
    if (ctx.cloudReady) {
      console.log(`${OK('✓')} Kinu account ready.`);
      console.log(DIM('Cloud workspaces run on Workers AI in your Cloudflare account, if you granted AI permissions at sign-in.'));
      console.log(DIM('To use your ChatGPT Codex subscription in local workspaces, run kinu provider connect codex.'));
    } else {
      console.log(`${WARN('!')} Not signed in to Kinu.`);
      console.log(DIM(`Run kinu auth${ctx.opts.origin ? ` --origin ${ctx.opts.origin}` : ''} when you are ready.`));
    }

    return 'handled';
  }

  if (!ctx.opts.yes && !ctx.opts.provider && !ctx.opts.localModel && !canPrompt()) {
    if (ctx.cloudReady) {
      console.log(`${OK('✓')} Kinu account ready.`);
      console.log(DIM('Workers AI uses the Cloudflare account you signed in with.'));
    } else {
      console.log(`${WARN('!')} Not signed in to Kinu: signing in needs an interactive terminal.`);
      console.log(DIM(`Run kinu auth${ctx.opts.origin ? ` --origin ${ctx.opts.origin}` : ''} when you are ready.`));
    }

    console.log(DIM('To pick a model provider for local workspaces, run kinu provider connect <provider>.'));

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
  local?: boolean;
}): Promise<void> {
  console.log('');
  console.log(ACCENT('Kinu setup'));
  console.log(DIM('Sign in to Kinu, then pick a model provider for local workspaces.'));
  console.log('');

  const config = loadConfigFile();
  let cloudReady = Boolean(config.accessToken);

  if (cloudReady) {
    console.log(`${OK('✓')} Signed in${config.user?.email ? ` as ${ACCENT(config.user.email)}` : ''}`);
    console.log(DIM('While you are signed in, new local workspaces run on Workers AI in your Cloudflare account, with no API key on this machine.'));
  }

  if (!opts.skipCloud && !config.accessToken) {
    // Without a terminal, readline would hang on a pipe (the `curl | bash` installer).
    const shouldLogin = opts.yes === true || (canPrompt() && await confirm('Sign in now and grant Workers AI permissions?', true));

    if (shouldLogin) {
      await authCommand({ origin: opts.origin });
      cloudReady = Boolean(loadConfigFile().accessToken);
    }
  }

  if (await runSetupPreflight({ opts, cloudReady }) === 'handled') return;

  const provider = normalizeProvider(opts.provider ?? (opts.yes ? 'workers-ai' : await chooseProvider(cloudReady)));

  if (provider === 'skip') {
    console.log(`${WARN('!')} Skipped choosing a model provider.`);
    console.log(DIM(cloudReady
      ? 'Cloud workspaces are ready. For local workspaces, run kinu provider connect <provider> later.'
      : 'Run kinu setup again before you create a workspace.'));

    return;
  }

  if (provider === 'workers-ai') {
    if (!cloudReady) {
      console.log(`${WARN('!')} Workers AI needs a signed-in Kinu account.`);
      console.log(DIM(`Run kinu auth${opts.origin ? ` --origin ${opts.origin}` : ''}, then kinu setup again.`));

      return;
    }

    const named = opts.model === undefined ? DEFAULT_WORKERS_AI_MODEL_SPEC : `workers-ai/${stripProvider(opts.model, 'workers-ai')}`;
    const current = adoptDefaultModel(named)?.model;
    console.log(`${OK('✓')} Using Cloudflare Workers AI`);

    if (current !== undefined) console.log(DIM(`Default model: ${current}`));

    if (opts.model !== undefined && current !== named) console.log(DIM(`To use ${named}, pick it under Defaults on kinu's home screen.`));
    console.log(DIM('No API key on this machine. Requests go through your Kinu account.'));

    return;
  }

  await connectProviderOnConsole(provider, connectOptions(opts));
}

async function chooseProvider(cloudReady: boolean): Promise<string> {
  console.log(DIM('Model provider for local workspaces:'));
  console.log(`  ${ACCENT('1')} Cloudflare Workers AI through your Kinu account ${DIM('(recommended)')}`);
  console.log(`  ${ACCENT('2')} ChatGPT Codex subscription`);
  console.log(`  ${ACCENT('3')} OpenAI API key`);
  console.log(`  ${ACCENT('4')} OpenRouter`);
  console.log(`  ${ACCENT('5')} Anthropic`);
  console.log(`  ${ACCENT('6')} OpenAI-compatible`);
  console.log(`  ${ACCENT('7')} OpenCode (uses your opencode sign-in and models)`);
  console.log(`  ${ACCENT('8')} Skip`);

  if (!cloudReady) console.log(DIM('  Option 1 needs a signed-in account. Run kinu auth first.'));

  // The Claude Code subscription stores no credential here; mention it only when usable on this machine.
  if ((await checkClaudeAvailability()).loggedIn) {
    console.log(DIM('  Claude Code is signed in here. To use your Claude subscription, pass --model claude/claude-opus-4-x.'));
  }

  const value = await ask('Choice', '1');

  return value;
}

/** Aliases shared by `kinu setup --provider` and `kinu provider connect`. Menu positions are not aliases; unknown tokens pass through. */
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

  // Menu positions on the --provider flag, pinned by setup-default-provider.test.ts.
  if (v === '1') return 'workers-ai';

  if (v === '2') return 'codex';

  if (v === '3') return 'openai';

  if (v === '4') return 'openrouter';

  if (v === '5') return 'anthropic';

  if (v === '6') return 'openai-compatible';

  if (v === '7') return 'opencode';

  if (v === '8' || v === 'skip' || v === 'none') return 'skip';

  // `cloudflare` is `workers-ai`; bare `claude` is the subscription, not the Anthropic API key.
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
