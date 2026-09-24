import { deleteCloudCredential, listCloudCredentials } from '../cloud-api';
import { bumpProviderRevision, resolveCloudSession, updateConfigFile, type KinuConfig } from '../config';
import { readDefaultTier } from '../profiles';
import { ACCENT, DIM, OK, WARN } from '../display';
import { readProviderConnections } from './provider-connect';
import { canonicalProviderName, connectOptions, connectProviderOnConsole } from './setup';
import * as v from 'valibot';
import { renderThrownChain } from '@kinu.run/core/obs';

type ProviderAction = 'list' | 'connect' | 'disconnect';

const ProviderNameSchema = v.picklist([
  'cloudflare',
  'claude',
  'codex',
  'openai',
  'openrouter',
  'anthropic',
  'openai-compatible',
  'opencode',
]);

type ProviderName = v.InferOutput<typeof ProviderNameSchema>;

interface ParsedProviderArgs {
  action: ProviderAction;
  provider?: ProviderName;
  raw?: string;
}

interface LocalCredential {
  clear: (providers: NonNullable<KinuConfig['providers']>) => boolean;
  envVars: string[];
  credKey?: string;
}

export async function providersCommand(actionOrProvider: string | undefined, providerArg: string | undefined, opts: {
  origin?: string;
  model?: string;
  local?: boolean;
}): Promise<void> {
  const { action, provider, raw } = parseArgs(actionOrProvider, providerArg);

  if (action === 'list') {
    await printProviders();

    return;
  }

  if (action === 'disconnect' && !provider && raw) {
    await disconnectAccountProvider(raw);

    return;
  }

  if (!provider) {
    throw new Error(`Choose a provider to ${action}: cloudflare, claude, codex, openai, openrouter, anthropic, openai-compatible, or opencode.`);
  }

  if (action === 'disconnect') {
    await disconnectProvider(provider);

    return;
  }

  await connectProviderOnConsole(provider, connectOptions(opts));
}

function parseArgs(actionOrProvider: string | undefined, providerArg: string | undefined): ParsedProviderArgs {
  if (!actionOrProvider) return { action: 'list' };

  const first = actionOrProvider.trim().toLowerCase();

  if (first === 'list' || first === 'ls' || first === 'status') return { action: 'list' };

  if (first === 'connect' || first === 'login' || first === 'add') {
    return { action: 'connect', provider: providerArg ? normalizeProvider(providerArg) : undefined };
  }

  if (first === 'disconnect' || first === 'remove' || first === 'rm' || first === 'delete') {
    // May be a models.dev provider connected in the web UI; resolved against the account, not rejected here.
    return { action: 'disconnect', provider: providerArg ? maybeProvider(providerArg) : undefined, raw: providerArg };
  }

  return { action: 'connect', provider: normalizeProvider(actionOrProvider) };
}

/** Env vars listed here keep supplying the credential after the file entry is gone. */
const LOCAL_CREDENTIALS = new Map<ProviderName, LocalCredential>([
  ['codex', {
    clear: (p) => deleteKey(p, 'codex'),
    envVars: ['CODEX_ACCESS_TOKEN'],
  }],
  ['openai', {
    clear: (p) => deleteKey(p, 'openai'),
    envVars: ['OPENAI_API_KEY'],
    credKey: 'openai.bearer',
  }],
  ['anthropic', {
    clear: (p) => deleteKey(p, 'anthropic'),
    envVars: ['ANTHROPIC_API_KEY'],
    credKey: 'anthropic.bearer',
  }],
  ['openrouter', {
    clear: (p) => deleteKey(p, 'openrouter'),
    envVars: ['OPENROUTER_API_KEY'],
    credKey: 'openrouter.bearer',
  }],
  ['openai-compatible', {
    clear: (p) => deleteKey(p, 'openaiCompat'),
    envVars: ['KINU_BASE_URL', 'KINU_AUTH'],
    credKey: 'openai-compat.default',
  }],
]);

function deleteKey(
  providers: NonNullable<KinuConfig['providers']>,
  key: keyof NonNullable<KinuConfig['providers']>,
): boolean {
  if (providers[key] === undefined) return false;
  delete providers[key];

  return true;
}

/** A default left on a disconnected provider fails every unpinned turn. */
const MODEL_SPEC_PREFIXES = new Map<ProviderName, readonly string[]>([
  ['codex', ['codex/']],
  ['openai', ['openai/']],
  ['anthropic', ['anthropic/']],
  ['openrouter', ['openrouter/']],
  ['openai-compatible', ['openai-compat/', 'openai-compat:']],
  ['claude', ['claude/']],
  ['opencode', ['opencode/']],
  ['cloudflare', ['workers-ai/', 'my-gateway/', 'ai-gateway/', '@cf/']],
]);

/** Only credentials Kinu stores; the account is `kinu logout`, and claude/opencode own their logins. */
async function disconnectProvider(provider: ProviderName): Promise<void> {
  console.log('');

  if (provider === 'cloudflare') {
    console.log(`${WARN('!')} Cloudflare and Workers AI connect through your Kinu account.`);
    console.log(DIM('  Sign out with: kinu logout'));
    console.log(DIM('  To disconnect Cloudflare itself, revoke it in Account settings in the Kinu app.'));

    return;
  }

  if (provider === 'claude' || provider === 'opencode') {
    const tool = provider === 'claude' ? 'Claude Code' : 'opencode';
    const command = provider === 'claude' ? 'claude logout' : 'opencode auth logout';
    console.log(`${WARN('!')} Kinu stores no ${tool} credential; it uses your ${tool} sign-in.`);
    console.log(DIM(`  Sign out of ${tool} itself: ${command}`));
    warnDefaultModelFor(provider);
    // Kinu holds nothing here, but a resident session must re-probe that tool's login.
    bumpProviderRevision();

    return;
  }

  const credential = LOCAL_CREDENTIALS.get(provider);

  if (!credential) throw new Error(`No local credential for ${provider}.`);

  let removed = false;
  updateConfigFile((config) => {
    if (config.providers) removed = credential.clear(config.providers);
  });

  if (removed) console.log(`${OK('✓')} Removed the ${ACCENT(provider)} credential from this machine.`);

  // Most connections use the account copy; otherwise the provider keeps working.
  const cloud = credential.credKey ? resolveCloudSession() : null;

  if (cloud && credential.credKey) {
    try {
      await deleteCloudCredential(cloud.origin, cloud.token, credential.credKey);
      console.log(`${OK('✓')} Removed the ${ACCENT(provider)} credential from your Kinu account.`);
      removed = true;
    } catch (e) {
      console.log(`${WARN('!')} Could not reach your Kinu account: ${renderThrownChain({ cause: e })}`);
    }
  }

  if (!removed) console.log(`${WARN('!')} ${provider} was not connected. Nothing to remove.`);

  warnDefaultModelFor(provider);
  // Published even when no row was found, so a resident session stops offering a revoked provider.
  bumpProviderRevision();

  const live = credential.envVars.filter((name) => process.env[name]);

  if (live.length > 0) {
    console.log(`${WARN('!')} ${live.join(' and ')} ${live.length > 1 ? 'are' : 'is'} still set in this environment.`);
    console.log(DIM('  Environment variables take precedence over the config file. Unset them to disconnect.'));
  }
}

/** A models.dev provider connected in the web UI: a catalog id, not a named provider. */
async function disconnectAccountProvider(name: string): Promise<void> {
  const cloud = resolveCloudSession();
  console.log('');

  if (!cloud) {
    throw new Error(`Unknown provider "${name}". Sign in with \`kinu auth\` to disconnect a provider held by your account.`);
  }

  const credKey = `${name.trim().toLowerCase()}.bearer`;
  const connected = (await listCloudCredentials(cloud.origin, cloud.token)).some((c) => c.key === credKey);

  if (!connected) {
    throw new Error(`Neither this machine nor your Kinu account has a "${name}" credential. Run \`kinu provider list\` to see what is connected.`);
  }

  await deleteCloudCredential(cloud.origin, cloud.token, credKey);
  console.log(`${OK('✓')} Removed the ${ACCENT(name)} credential from your Kinu account.`);
  warnDefaultModelPrefixes([`${name}/`]);
  bumpProviderRevision();
}

function warnDefaultModelFor(provider: ProviderName): void {
  warnDefaultModelPrefixes(MODEL_SPEC_PREFIXES.get(provider) ?? []);
}

function warnDefaultModelPrefixes(prefixes: readonly string[]): void {
  const current = readDefaultTier()?.model;

  if (current === undefined || !prefixes.some((prefix) => current.startsWith(prefix))) return;
  console.log(`${WARN('!')} The default model ${current} runs on it; pick another under Defaults on kinu's home screen.`);
}

function maybeProvider(value: string): ProviderName | undefined {
  const parsed = v.safeParse(ProviderNameSchema, canonicalProviderName(value));

  return parsed.success ? parsed.output : undefined;
}

function normalizeProvider(value: string): ProviderName {
  const provider = maybeProvider(value);

  if (!provider) {
    throw new Error('Provider must be cloudflare, claude, codex, openai, openrouter, anthropic, openai-compatible, or opencode.');
  }

  return provider;
}

async function printProviders(): Promise<void> {
  const connections = await readProviderConnections();
  console.log('');
  console.log(ACCENT('Model providers'));
  console.log('');

  for (const state of connections.states) {
    if (state.connected) console.log(`  ${OK('\u2713')} ${ACCENT(state.descriptor.label)} ${DIM(state.detail)}`);
    else console.log(`  ${WARN('!')} ${state.descriptor.label} ${DIM(state.detail)}`);

    if (state.descriptor.id === 'cloudflare' && state.connected) {
      console.log(`    ${DIM('Cloud workspaces use your Workers AI quota if you granted AI permissions at sign-in.')}`);
      console.log(`    ${DIM('Local workspaces use the same Workers AI while you are signed in, with no key on this computer.')}`);
    }

    if (state.descriptor.id === 'cloudflare' && connections.accountUnreachable !== undefined) {
      console.log(`    ${WARN('!')} Could not read the keys stored in your account (${connections.accountUnreachable}).`);
      console.log(`    ${DIM('The rows below show only what is on this computer.')}`);
    }
  }

  for (const key of connections.accountExtras) {
    console.log(`  ${OK('\u2713')} ${ACCENT(key.replace(/\.bearer$/, ''))} ${DIM('your account')}`);
  }

  console.log('');
  console.log(DIM('  New keys are stored in your Kinu account, not on this computer.'));
  console.log(DIM('  To keep a key on this computer instead: kinu provider connect <name> --local'));
  console.log(DIM('  To remove a key: kinu provider disconnect <name>'));
  console.log('');
}
