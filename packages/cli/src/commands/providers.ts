import { deleteCloudCredential, listCloudCredentials } from '../cloud-api';
import { bumpProviderRevision, resolveCloudSession, updateConfigFile, type KinuConfig } from '../config';
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
  /** What the user typed, when it named nothing this CLI knows. */
  raw?: string;
}

interface LocalCredential {
  clear: (providers: NonNullable<KinuConfig['providers']>) => boolean;
  envVars: string[];
  /** The account-side key the same provider is stored under, when it can be. */
  credKey?: string;
}

export async function providersCommand(actionOrProvider: string | undefined, providerArg: string | undefined, opts: {
  origin?: string;
  model?: string;
  /** Keep the secret on this machine instead of the Kinu account. */
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
    // A name this CLI has no branch for may still be one of the models.dev
    // providers connected in the web UI, which `provider list` now shows. It
    // is resolved against the account rather than rejected here.
    return { action: 'disconnect', provider: providerArg ? maybeProvider(providerArg) : undefined, raw: providerArg };
  }

  return { action: 'connect', provider: normalizeProvider(actionOrProvider) };
}

/** The credential a provider stores in ~/.kinu/config.json, and the env
 *  vars that would keep supplying it after the file entry is gone. Providers
 *  absent from this map hold no Kinu-owned credential. */
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

function deleteKey<K extends keyof NonNullable<KinuConfig['providers']>>(
  providers: NonNullable<KinuConfig['providers']>,
  key: K,
): boolean {
  if (providers[key] === undefined) return false;
  delete providers[key];

  return true;
}

/** The model-spec prefixes a provider serves — a default model left pointing
 *  at a disconnected provider is exactly the "no connected provider" trap
 *  `kinu create` warns about, so the pointer goes with the credential. */
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

/**
 * The inverse of `provider connect`: remove the stored credential.
 *
 * Only the providers Kinu stores a credential FOR can be disconnected
 * here. The Kinu account is `kinu logout`, and the two subscription
 * bridges (claude, opencode) are other tools' logins — Kinu holds nothing
 * to delete, and saying so beats pretending the command did something.
 */
async function disconnectProvider(provider: ProviderName): Promise<void> {
  console.log('');

  if (provider === 'cloudflare') {
    console.log(`${WARN('!')} Cloudflare and Workers AI connect through your Kinu account.`);
    console.log(DIM('  Sign out with: kinu logout'));
    console.log(DIM('  To disconnect Cloudflare itself, revoke it in your Kinu account settings.'));

    return;
  }

  if (provider === 'claude' || provider === 'opencode') {
    const tool = provider === 'claude' ? 'Claude Code' : 'opencode';
    const command = provider === 'claude' ? 'claude logout' : 'opencode auth logout';
    console.log(`${WARN('!')} Kinu stores no ${tool} credential. It drives the ${tool} login.`);
    console.log(DIM(`  Sign out of ${tool} itself: ${command}`));
    clearDefaultModelFor(provider);
    // Kinu holds no credential for these two, but the user ran this command
    // because they are signing out of that tool — and its login is exactly what
    // a listing sweep re-probes, so a resident session must sweep again.
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

  // The account copy is the one most connections now use, so disconnecting
  // has to reach it too — otherwise the provider keeps working and the command
  // looks broken.
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

  clearDefaultModelFor(provider);
  // Published whether or not a row was found: the command's whole job is to
  // change what a model resolution can reach, and a resident session that keeps
  // offering a revoked provider is the defect this signal closes.
  bumpProviderRevision();

  const live = credential.envVars.filter((name) => process.env[name]);

  if (live.length > 0) {
    console.log(`${WARN('!')} ${live.join(' and ')} ${live.length > 1 ? 'are' : 'is'} still set in this environment.`);
    console.log(DIM('  Environment credentials win over the config file. Unset them to disconnect.'));
  }
}

/**
 * Disconnect one of the models.dev providers connected in the web UI. This CLI
 * has no branch for those — they are catalog ids, not one of its eight named
 * providers — but `provider list` shows them, and a list you cannot act on is
 * a one-way door.
 */
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
  clearDefaultModelPrefixes([`${name}/`]);
  bumpProviderRevision();
}

/** Drop the default model spec when it names the provider being removed. */
function clearDefaultModelFor(provider: ProviderName): void {
  clearDefaultModelPrefixes(MODEL_SPEC_PREFIXES.get(provider) ?? []);
}

function clearDefaultModelPrefixes(prefixes: readonly string[]): void {
  let cleared: string | null = null;
  updateConfigFile((config) => {
    const model = config.model;

    if (!model || !prefixes.some((prefix) => model.startsWith(prefix))) return;
    cleared = model;
    delete config.model;
  });

  if (cleared) console.log(DIM(`  Cleared the default model (${cleared}).`));
}

/** `normalizeProvider`, but undefined instead of throwing. */
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
  console.log(ACCENT('Kinu providers'));
  console.log('');

  for (const state of connections.states) {
    if (state.connected) console.log(`  ${OK('\u2713')} ${ACCENT(state.descriptor.label)} ${DIM(state.detail)}`);
    else console.log(`  ${WARN('!')} ${state.descriptor.label} ${DIM(state.detail)}`);

    if (state.descriptor.id === 'cloudflare' && state.connected) {
      console.log(`    ${DIM('Cloud workspaces use your Workers AI quota, if you granted AI permissions at sign-in.')}`);
      console.log(`    ${DIM('Local workspaces reach the same Workers AI while you are signed in, with no key on this machine.')}`);
    }

    if (state.descriptor.id === 'cloudflare' && connections.accountUnreachable !== undefined) {
      console.log(`    ${WARN('!')} Could not read the keys stored in your account (${connections.accountUnreachable}).`);
      console.log(`    ${DIM('The lines below show only what is on this machine.')}`);
    }
  }

  // Everything else the account holds — the models.dev tail connected in the
  // web UI, which this machine can use without ever holding the key.
  for (const key of connections.accountExtras) {
    console.log(`  ${OK('\u2713')} ${ACCENT(key.replace(/\.bearer$/, ''))} ${DIM('your account')}`);
  }

  console.log('');
  console.log(DIM('  Keys connect to your Kinu account by default. No copy on this disk.'));
  console.log(DIM('  Keep one here instead: kinu provider connect <name> --local'));
  console.log(DIM('  Remove a stored credential: kinu provider disconnect <name>'));
  console.log('');
}
