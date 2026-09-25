import { deleteCloudCredential, listCloudCredentials } from '../cloud-api';
import { API_KEY_PROVIDERS, bumpProviderRevision, resolveCloudSession, updateConfigFile, type KinuConfig } from '../config';
import { readDefaultAccounts, readDefaultTier } from '../profiles';
import { updateDefaultAccount } from '../default-model';
import { ACCENT, DIM, OK, WARN } from '../display';
import { holdsAccounts, readProviderConnections } from './provider-connect';
import { canonicalProviderName, connectOptions, connectProviderOnConsole } from './setup';
import * as v from 'valibot';
import { MAIN_ACCOUNT, accountCredentialKey, catalogCredKey, isAccountName } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';

type ProviderAction = 'list' | 'connect' | 'disconnect' | 'default';

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
  account: string;
}

interface LocalCredential {
  clear: (providers: NonNullable<KinuConfig['providers']>) => boolean;
  envVars: string[];
  credKey?: string;
}

export async function providersCommand(
  actionOrProvider: string | undefined,
  providerArg: string | undefined,
  accountArg: string | undefined,
  opts: { origin?: string; model?: string; local?: boolean },
): Promise<void> {
  const { action, provider, raw, account } = parseArgs(actionOrProvider, providerArg, accountArg);

  if (action === 'list') {
    await printProviders();

    return;
  }

  if (action === 'default') {
    await setDefaultAccount(raw, account);

    return;
  }

  if (action === 'disconnect' && !provider && raw) {
    await disconnectAccountProvider(raw, account);

    return;
  }

  if (!provider) {
    throw new Error(`Choose a provider to ${action}: cloudflare, claude, codex, openai, openrouter, anthropic, openai-compatible, or opencode.`);
  }

  if (action === 'disconnect') {
    await (account === MAIN_ACCOUNT ? disconnectProvider(provider) : disconnectAccount(provider, account));

    return;
  }

  await connectProviderOnConsole(provider, { ...connectOptions(opts), account });
}

function parseArgs(
  actionOrProvider: string | undefined,
  providerArg: string | undefined,
  accountArg: string | undefined,
): ParsedProviderArgs {
  if (!actionOrProvider) return { action: 'list', account: MAIN_ACCOUNT };

  const first = actionOrProvider.trim().toLowerCase();
  const verbs = ['list', 'ls', 'status', 'default', 'connect', 'login', 'add', 'disconnect', 'remove', 'rm', 'delete'];
  const named = verbs.includes(first) ? accountArg : providerArg;
  const account = named?.trim().toLowerCase() ?? MAIN_ACCOUNT;

  if (!isAccountName(account)) throw new Error(`"${named}" is not an account name: use a-z, 0-9 and dashes.`);

  if (first === 'list' || first === 'ls' || first === 'status') return { action: 'list', account };

  if (first === 'default') return { action: 'default', raw: providerArg, account: named === undefined ? '' : account };

  if (first === 'connect' || first === 'login' || first === 'add') {
    return { action: 'connect', provider: providerArg ? normalizeProvider(providerArg) : undefined, account };
  }

  if (first === 'disconnect' || first === 'remove' || first === 'rm' || first === 'delete') {
    // May be a models.dev provider connected in the web UI; resolved against the account, not rejected here.
    return { action: 'disconnect', provider: providerArg ? maybeProvider(providerArg) : undefined, raw: providerArg, account };
  }

  return { action: 'connect', provider: normalizeProvider(actionOrProvider), account };
}

function specProviderId(name: string): string {
  const canonical = canonicalProviderName(name);

  if (canonical === 'openai-compatible' || canonical === 'opencode' || canonical === 'cloudflare') {
    throw new Error(`${canonical} holds one account: accounts are for openai, openrouter, anthropic, codex, claude and API keys connected in the web app.`);
  }

  return canonical;
}

async function setDefaultAccount(name: string | undefined, account: string): Promise<void> {
  if (!name || account === '') throw new Error('Name the provider and the account: kinu provider default <provider> <account>.');
  const provider = specProviderId(name);
  await updateDefaultAccount(provider, account);
  console.log('');
  console.log(`${OK('✓')} ${ACCENT(provider)} models that name no account now run on ${ACCENT(account)}.`);
  const connected = (await readProviderConnections()).states.find((state) => state.descriptor.id === provider);

  if (connected !== undefined && account !== MAIN_ACCOUNT && !(connected.accounts ?? []).includes(account)) {
    console.log(`${WARN('!')} No ${provider} account named ${account} is connected yet: kinu provider connect ${provider} ${account}`);
  }
}

async function disconnectAccount(provider: ProviderName, account: string): Promise<void> {
  if (!holdsAccounts(provider)) throw new Error(`${provider} holds one account.`);
  console.log('');
  let removed = false;

  await updateConfigFile((config) => {
    const accounts = config.providers?.[provider]?.accounts;
    removed = accounts?.[account] !== undefined;
    delete accounts?.[account];
  });

  if (removed) console.log(`${OK('✓')} Removed the ${ACCENT(`${provider} ${account}`)} account from this machine.`);
  const cloud = provider === 'codex' || provider === 'claude' ? null : resolveCloudSession();

  if (cloud && provider !== 'codex' && provider !== 'claude') {
    const credKey = accountCredentialKey(API_KEY_PROVIDERS[provider], account);

    if ((await listCloudCredentials(cloud.origin, cloud.token)).some((c) => c.key === credKey)) {
      await deleteCloudCredential(cloud.origin, cloud.token, credKey);
      console.log(`${OK('✓')} Removed the ${ACCENT(`${provider} ${account}`)} account from your Kinu account.`);
      removed = true;
    }
  }

  if (!removed) console.log(`${WARN('!')} No ${provider} account named ${account} was connected. Nothing to remove.`);
  await forgetDefaultAccount(provider, account);
  await bumpProviderRevision();
}

async function forgetDefaultAccount(provider: string, account: string): Promise<void> {
  if (readDefaultAccounts()[provider] !== account) return;
  await updateDefaultAccount(provider, null);
  console.log(`${WARN('!')} ${account} was the default ${provider} account; ${provider} models now run on main, or its only account.`);
}

/** Env vars listed here keep supplying the credential after the file entry is gone. */
const LOCAL_CREDENTIALS = new Map<ProviderName, LocalCredential>([
  ['codex', {
    clear: (p) => deleteMain(p, 'codex'),
    envVars: ['CODEX_ACCESS_TOKEN'],
  }],
  ['claude', {
    clear: (p) => deleteMain(p, 'claude'),
    envVars: [],
  }],
  ['openai', {
    clear: (p) => deleteMain(p, 'openai'),
    envVars: ['OPENAI_API_KEY'],
    credKey: 'openai.bearer',
  }],
  ['anthropic', {
    clear: (p) => deleteMain(p, 'anthropic'),
    envVars: ['ANTHROPIC_API_KEY'],
    credKey: 'anthropic.bearer',
  }],
  ['openrouter', {
    clear: (p) => deleteMain(p, 'openrouter'),
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

function deleteMain(providers: NonNullable<KinuConfig['providers']>, key: 'codex' | 'claude' | 'openai' | 'anthropic' | 'openrouter'): boolean {
  const entry = providers[key];

  if (entry?.accounts === undefined || Object.keys(entry.accounts).length === 0) return deleteKey(providers, key);
  const mainFields = Object.keys(entry).filter((field) => field !== 'accounts');

  for (const field of mainFields) Reflect.deleteProperty(entry, field);

  return mainFields.length > 0;
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

/** Only credentials Kinu stores; the account is `kinu logout`, and opencode owns its login. */
async function disconnectProvider(provider: ProviderName): Promise<void> {
  console.log('');

  if (provider === 'cloudflare') {
    console.log(`${WARN('!')} Cloudflare and Workers AI connect through your Kinu account.`);
    console.log(DIM('  Sign out with: kinu logout'));
    console.log(DIM('  To disconnect Cloudflare itself, revoke it in Account settings in the Kinu app.'));

    return;
  }

  if (provider === 'opencode') {
    console.log(`${WARN('!')} Kinu stores no opencode credential; it uses your opencode sign-in.`);
    console.log(DIM('  Sign out of opencode itself: opencode auth logout'));
    warnDefaultModelFor(provider);
    // Kinu holds nothing here, but a resident session must re-probe that tool's login.
    await bumpProviderRevision();

    return;
  }

  const credential = LOCAL_CREDENTIALS.get(provider);

  if (!credential) throw new Error(`No local credential for ${provider}.`);

  let removed = false;
  await updateConfigFile((config) => {
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
  await bumpProviderRevision();

  const live = credential.envVars.filter((name) => process.env[name]);

  if (live.length > 0) {
    console.log(`${WARN('!')} ${live.join(' and ')} ${live.length > 1 ? 'are' : 'is'} still set in this environment.`);
    console.log(DIM('  Environment variables take precedence over the config file. Unset them to disconnect.'));
  }
}

/** A models.dev provider connected in the web UI: a catalog id, not a named provider. */
async function disconnectAccountProvider(name: string, account: string): Promise<void> {
  const cloud = resolveCloudSession();
  console.log('');

  if (!cloud) {
    throw new Error(`Unknown provider "${name}". Sign in with \`kinu auth\` to disconnect a provider held by your account.`);
  }

  const provider = name.trim().toLowerCase();
  const credKey = accountCredentialKey(catalogCredKey(provider), account);
  const connected = (await listCloudCredentials(cloud.origin, cloud.token)).some((c) => c.key === credKey);

  if (!connected) {
    throw new Error(`Neither this machine nor your Kinu account has a "${name}" credential. Run \`kinu provider list\` to see what is connected.`);
  }

  await deleteCloudCredential(cloud.origin, cloud.token, credKey);
  console.log(`${OK('✓')} Removed the ${ACCENT(account === MAIN_ACCOUNT ? name : `${name} ${account}`)} credential from your Kinu account.`);
  await forgetDefaultAccount(provider, account);
  warnDefaultModelPrefixes([`${name}/`]);
  await bumpProviderRevision();
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

  const defaults = readDefaultAccounts();

  for (const state of connections.states) {
    if (state.connected) console.log(`  ${OK('\u2713')} ${ACCENT(state.descriptor.label)} ${DIM(state.detail)}`);
    else console.log(`  ${WARN('!')} ${state.descriptor.label} ${DIM(state.detail)}`);

    if ((state.accounts ?? []).length > 0) {
      const chosen = defaults[state.descriptor.id] ?? MAIN_ACCOUNT;
      const names = [MAIN_ACCOUNT, ...state.accounts ?? []].map((name) => (name === chosen ? `${name} (default)` : name));
      console.log(`    ${DIM(`accounts: ${names.join(', ')}`)}`);
    }

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
  console.log(DIM('  Another account: kinu provider connect <name> <account>; pick the default: kinu provider default <name> <account>'));
  console.log('');
}
