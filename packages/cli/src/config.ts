import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  ANTHROPIC_DEFAULT_MODEL,
  CHATGPT_DEFAULT_MODEL,
  DEFAULT_WORKERS_AI_MODEL_ID,
  WORKERS_AI_PROVIDER_ID, WORKERS_AI_MODEL_ID_PREFIX,
  OPENAI_DEFAULT_MODEL,
  OPENROUTER_DEFAULT_MODEL,
  accountCredentialKey, credentialToHeaders, openWorkspaceMainActor, discoverOpenAICompatibleModels, specWithoutAccount,
  type LLMProviderConfig,
  type ModelInfo,
  type OpenAICompatCredential,
  PROVIDER_KEY_ENV,
  SESSION_CREDENTIAL_ENV,
  CLOUD_PROXY_PROVIDER_IDS,
} from '@kinu.run/core';
import { attempt, KinuError, settle, settleSync } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import {
  makeSql,
  createFileOAuthStore,
  KinuAgentConfigSchema,
  OpenAiCompatConfigSchema,
  ensureSecretDir,
  kinuHome,
  readConfigFile,
  stripProvider,
  updateConfigFile as updateConfigAt,
  type KinuAgentConfig,
  type KinuConfig,
  type LocalCloudSession,
  type LocalOAuthStore,
  type LocalProviderCredentials,
  type McpServerConfig,
} from '@kinu.run/cli-backend';
import * as v from 'valibot';

export type { KinuAgentConfig, KinuConfig, LocalApiKeyProvider, LocalOAuthSession } from '@kinu.run/cli-backend';

export const AGENT_HOME = kinuHome();

export const CONFIG_PATH = join(AGENT_HOME, 'config.json');

export const BIN_DIR = join(AGENT_HOME, 'bin');

const KINU_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const DEFAULT_ORIGIN = 'https://kinu.run';

export type AgentMode = KinuAgentConfig['mode'];

export function ensureAgentHome(): void {
  ensureSecretDir(AGENT_HOME);
}

export function ensureBinDir(): void {
  ensureAgentHome();
  mkdirSync(BIN_DIR, { recursive: true });
}

/** One identity per project; a missing directory falls back to its absolute path rather than aborting on `lstat`. */
export function canonicalProjectRoot(cwd = process.cwd()): string {
  const absolute = resolve(cwd);

  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

export function defaultVirtualWorkspaceId(cwd = process.cwd()): string {
  const candidate = basename(canonicalProjectRoot(cwd))
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');

  return candidate && KINU_IDENTIFIER_RE.test(candidate) ? candidate : 'workspace';
}

export function agentDir(name: string): string {
  validateAgentName(name);

  return join(AGENT_HOME, name);
}

export function agentDbPath(name: string): string {
  return join(agentDir(name), 'agent.db');
}

export interface LocalAgentRef {
  name: string;
  cwd: string;
  workspaceId: string;
  dbPath: string;
}

/** Null without a recorded folder that still exists: such a workspace is listed nowhere and refused at open. */
function placedRef(agent: KinuAgentConfig): LocalAgentRef | null {
  if (agent.mode !== 'local' || !existsSync(agent.cwd)) return null;
  const name = agent.localName;

  if (!KINU_IDENTIFIER_RE.test(name)) return null;

  return {
    name,
    cwd: agent.cwd,
    workspaceId: agent.workspaceId,
    dbPath: agentDbPath(name),
  };
}

export function listLocalRefsAllProjects(): LocalAgentRef[] {
  return Object.values(loadConfigFile().agents ?? {})
    .map(placedRef)
    .filter((ref): ref is LocalAgentRef => ref !== null && existsSync(ref.dbPath))
    .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId) || a.name.localeCompare(b.name));
}

function listLocalRefs(cwd = process.cwd()): LocalAgentRef[] {
  const root = canonicalProjectRoot(cwd);

  return listLocalRefsAllProjects().filter((ref) => ref.cwd === root);
}

export function localWorkspaceMembers(workspaceId: string, cwd = process.cwd()): LocalAgentRef[] {
  return listLocalRefs(cwd).filter((ref) => ref.workspaceId === workspaceId);
}

/** The workspace placed here whose database was written last. */
export function lastUsedLocalRef(cwd = process.cwd()): LocalAgentRef | null {
  let latest: { readonly ref: LocalAgentRef; readonly writtenAt: number } | null = null;

  for (const ref of listLocalRefs(cwd)) {
    // WAL writes land in -wal until a checkpoint.
    const writtenAt = Math.max(...[ref.dbPath, `${ref.dbPath}-wal`]
      .map((path) => statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0));

    if (latest === null || writtenAt > latest.writtenAt) latest = { ref, writtenAt };
  }

  return latest?.ref ?? null;
}

export function listAgentDirs(cwd = process.cwd()): string[] {
  return listLocalRefs(cwd).map((ref) => ref.name);
}

function readWorkspaceIdentityId(dbPath: string): Effect.Effect<string, KinuError> {
  return Effect.try({
    try: () => {
      // A WAL database needs its -shm, so the connection is read-write.
      const db = new Database(dbPath, { readwrite: true, create: false });

      try {
        const row = db.query<{ id: string }, []>(`SELECT id FROM workspace_identity LIMIT 1`).get();

        return v.parse(v.object({ id: v.pipe(v.string(), v.nonEmpty()) }), row).id;
      } finally {
        db.close();
      }
    },
    catch: (cause) => new KinuError('io', `${dbPath} has a corrupt workspace identity. Reinstall the local workspace.`, { cause }),
  });
}

/** The only label source for local agents; config.json holds no copy, so renames cannot drift. */
export function readWorkspaceDisplayName(dbPath: string): string | null {
  if (!existsSync(dbPath)) return null;

  return settleSync(Effect.try({
    try: () => {
      // Read-write: see readWorkspaceIdentityId.
      const db = new Database(dbPath, { readwrite: true, create: false });

      try {
        return openWorkspaceMainActor(makeSql(db)).config.getDisplayName();
      } finally {
        db.close();
      }
    },
    catch: (cause) => new KinuError('io', `${dbPath} is corrupt. Reinstall the local workspace.`, { cause }),
  }));
}

/** A new local workspace's ref: the folder it works in, and its database's identity (`assertIdentityUnchanged`). */
export function placeLocalWorkspace(input: { name: string; cwd: string; workspaceId: string }): Promise<void> {
  return settle(Effect.gen(function* () {
    const identityId = yield* readWorkspaceIdentityId(agentDbPath(input.name));
    yield* attempt({ doing: 'placing a local workspace', otherwise: 'io' }, async () => upsertAgentConfig({
      name: input.name,
      mode: 'local',
      localName: input.name,
      cwd: input.cwd,
      workspaceId: input.workspaceId,
      identityId,
    }));
  }));
}

export class MissingLocalWorkspaceError extends Error {
  readonly hint: string;

  constructor(workspaceName: string) {
    super(`Workspace "${workspaceName}" not found.`);
    this.name = 'MissingLocalWorkspaceError';
    this.hint = `Create it with: kinu create ${workspaceName}`;
  }
}

/** The one local resolution: a workspace works in the folder its ref records, and one without a folder is refused. */
export function resolveLocalAgent(input: string): LocalAgentRef {
  const ref = resolveAgentRef(input);

  if (ref && ref.mode !== 'local') {
    throw new Error(`"${input}" is a cloud workspace; this needs a local one.`);
  }

  const name = ref === null ? input : ref.localName;

  if (!existsSync(agentDbPath(name))) throw new MissingLocalWorkspaceError(name);
  const placed = ref ? placedRef(ref) : null;

  if (!ref || !placed) {
    return settleSync(Effect.fail(new KinuError('missing', `Workspace "${name}" has no folder; create a new one from the folder it should work in.`)));
  }

  return settleSync(Effect.map(assertIdentityUnchanged(ref, placed), () => placed));
}

/** A changed identity means the name was reused; continuing would attach history to a different workspace. */
function assertIdentityUnchanged(agent: Extract<KinuAgentConfig, { mode: 'local' }>, ref: LocalAgentRef): Effect.Effect<void, KinuError> {
  return Effect.gen(function* () {
    const actual = yield* readWorkspaceIdentityId(ref.dbPath);

    if (actual === agent.identityId) return;

    return yield* new KinuError('io',
      `Workspace "${ref.name}" at ${ref.dbPath} is not the one recorded for ${ref.cwd}: `
      + `expected identity ${agent.identityId}, found ${actual}. `
      + 'Rename one of them, or remove the stale entry from ~/.kinu/config.json.',
    );
  });
}

/** This machine's config (`readConfigFile`). */
export function loadConfigFile(): KinuConfig {
  return readConfigFile(CONFIG_PATH);
}

/** The one config writer (`updateConfigFile`): `mutate` changes the config in place, under the lock, since a blind
 *  overwrite drops other processes' writes. */
export function updateConfigFile<T>(mutate: (config: KinuConfig) => T | Promise<T>): Promise<T> {
  return updateConfigAt(CONFIG_PATH, mutate);
}

/** Read on every profile resolution, so a plain file read. An unreadable config throws rather than answer 0. */
export function readProviderRevision(): number {
  return loadConfigFile().providerRevision ?? 0;
}

/** The only signal a resident daemon or chat session gets that its cached provider listing is stale. */
export async function bumpProviderRevision(): Promise<number> {
  let next = 0;
  await updateConfigFile((config) => {
    next = (config.providerRevision ?? 0) + 1;
    config.providerRevision = next;
  });

  return next;
}

export function resolveCloudOrigin(opts?: { origin?: string }): string {
  // An empty `KINU_ORIGIN` is no origin, as an unset one.
  const environment = process.env.KINU_ORIGIN === '' ? undefined : process.env.KINU_ORIGIN;

  return (opts?.origin ?? environment ?? loadConfigFile().origin ?? DEFAULT_ORIGIN).replace(/\/+$/, '');
}

/** The session a command sends with. A `--origin` naming another deployment is refused, never sent the token: a token
 *  goes to the deployment it belongs to alone. */
export function requireAuthConfig(opts: { origin?: string } = {}): LocalCloudSession {
  const session = resolveCloudSession() ?? storedAuthConfig('Not authenticated. Run: kinu auth (or set KINU_TOKEN)');

  if (opts.origin === undefined || new URL(resolveCloudOrigin(opts)).origin === new URL(session.origin).origin) return session;

  return settleSync(Effect.fail(new KinuError('bad_input', `Signed in to ${session.origin}, not ${opts.origin}: sign in there first with kinu auth --origin ${opts.origin}`)));
}

export function requireStoredAuthConfig(): LocalCloudSession {
  return storedAuthConfig('No interactive CLI session found. Run: kinu auth');
}

/** The deployment a stored sign-in was made at (`kinu auth` saves it), which alone may receive its token. */
export function storedSessionOrigin(config: KinuConfig): string {
  return (config.origin ?? DEFAULT_ORIGIN).replace(/\/+$/, '');
}

/** The stored session, refused where `KINU_ORIGIN` names another deployment: its token goes to its own alone. */
function storedAuthConfig(missingTokenMessage: string): LocalCloudSession {
  const config = loadConfigFile();
  const token = config.accessToken;
  const origin = storedSessionOrigin(config);

  if (!token) throw new Error(missingTokenMessage);
  const refusal = storedSessionRefusal(config, origin);

  if (refusal !== null) throw new Error(refusal);

  return { origin, token };
}

/** Why the stored session cannot be used here: it expired, or `KINU_ORIGIN` names another deployment; null when it can. */
function storedSessionRefusal(config: KinuConfig, origin: string): string | null {
  if (sessionExpired(config)) return 'Your Kinu CLI session has expired. Run: kinu auth';
  const asked = resolveCloudOrigin();

  if (new URL(asked).origin === new URL(origin).origin) return null;

  return `Signed in to ${origin}, but KINU_ORIGIN names ${asked}: sign in there with kinu auth --origin ${asked}, or unset KINU_ORIGIN.`;
}

export function sessionExpired(config: KinuConfig): boolean {
  if (!config.tokenExpiresAt) return false;
  const expiresAt = Date.parse(config.tokenExpiresAt);

  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

/** CI's `KINU_TOKEN` (usually a scoped `pta_…` token) wins over the stored session; the server decides validity.
 *  An unreadable config throws: it is not a signed-out user. */
export function resolveCloudSession(): LocalCloudSession | null {
  const envToken = process.env[SESSION_CREDENTIAL_ENV.token]?.trim();

  if (envToken) return { origin: resolveCloudOrigin(), token: envToken };
  const config = loadConfigFile();

  return config.accessToken && !sessionExpired(config) ? storedAuthConfig('') : null;
}

export function resolveAgentRef(input: string): KinuAgentConfig | null {
  return loadConfigFile().agents?.[input] ?? null;
}

export function listConfiguredAgentRefs(): KinuAgentConfig[] {
  return Object.values(loadConfigFile().agents ?? {})
    .sort((a, b) => a.name.localeCompare(b.name));
}

type AgentConfigWrite = (
  Omit<Extract<KinuAgentConfig, { mode: 'local' }>, 'createdAt' | 'updatedAt'>
  | Omit<Extract<KinuAgentConfig, { mode: 'cloud' }>, 'createdAt' | 'updatedAt'>
) & Partial<Pick<KinuAgentConfig, 'createdAt' | 'updatedAt'>>;

export async function upsertAgentConfig(agent: AgentConfigWrite): Promise<KinuAgentConfig> {
  validateAgentName(agent.name);

  if (agent.localName) validateAgentName(agent.localName);

  if (agent.cloudName) validateAgentName(agent.cloudName);

  if (agent.workspaceId) validateWorkspaceId(agent.workspaceId);
  const now = new Date().toISOString();
  let saved!: KinuAgentConfig;
  await updateConfigFile((config) => {
    const existing = config.agents?.[agent.name];
    saved = v.parse(KinuAgentConfigSchema, {
      ...existing,
      ...agent,
      createdAt: agent.createdAt ?? existing?.createdAt ?? now,
      updatedAt: now,
    });
    config.agents = { ...config.agents, [agent.name]: saved };
  });

  return saved;
}

export async function removeCloudAgentConfig(cloudName: string): Promise<boolean> {
  let removed = false;
  await updateConfigFile((config) => {
    const agents = config.agents ?? {};

    for (const [name, agent] of Object.entries(agents)) {
      if (agent.mode !== 'cloud' || agent.cloudName !== cloudName) continue;
      delete agents[name];
      removed = true;
    }

    config.agents = agents;
  });

  return removed;
}

function validateIdentifier(value: string, noun: string): void {
  if (!KINU_IDENTIFIER_RE.test(value)) {
    throw new Error(`${noun} must be 1-64 characters: letters, numbers, dashes, or underscores; it must start with a letter or number.`);
  }
}

function validateAgentName(name: string): void {
  validateIdentifier(name, 'Agent name');
}

export function validateWorkspaceId(workspaceId: string): void {
  validateIdentifier(workspaceId, 'Workspace id');
}

/** This machine's model choice: the spec a bare id or no choice means, and an endpoint the process was given. */
export interface LocalModelDefaults {
  /** A full spec (`provider/model`), resolved by the registry with this machine's credentials; null where nothing
   *  derives one. */
  readonly spec: string | null;
  /** An endpoint the process was given (`--base-url` and `--auth`, or `KINU_BASE_URL` and `KINU_AUTH`), served as
   *  itself; null without one. */
  readonly endpoint: LLMProviderConfig | null;
  /** What an incomplete setup still lacks, as the fix to name: a base URL given with no auth header and nothing else
   *  to serve. A path that runs a model refuses with it ({@link usableModelDefaults}); a readiness view reads it as
   *  not set up. Null when the setup is complete or simply absent. */
  readonly missing: string | null;
}

interface ModelChoice {
  model?: string;
  baseUrl?: string;
  auth?: string;
  defaultModel?: string;
}

/** What the invocation names, over the environment: a base URL, its auth, and the model (its account dropped). */
function chosenModel(opts: ModelChoice | undefined) {
  const named = opts?.model ?? process.env.KINU_MODEL ?? process.env.AI_GATEWAY_MODEL ?? opts?.defaultModel;

  return {
    baseURL: opts?.baseUrl ?? process.env.KINU_BASE_URL ?? process.env.AI_GATEWAY_BASE_URL,
    auth: opts?.auth ?? process.env[SESSION_CREDENTIAL_ENV.auth] ?? process.env[SESSION_CREDENTIAL_ENV.gatewayAuth],
    model: named === undefined ? undefined : specWithoutAccount(named),
  };
}

/** An endpoint the process was given, serving `model` (Workers AI's default where none is named) as itself: named
 *  Workers AI for a named Workers AI model, else compatible, and spelled as Workers AI wherever it serves one. */
function givenEndpoint(baseURL: string, auth: string, model: string | undefined): LocalModelDefaults {
  const name = model?.startsWith('@cf/') ? WORKERS_AI_PROVIDER_ID : 'openai-compat';
  const endpointModel = directEndpointModelId(model ?? DEFAULT_WORKERS_AI_MODEL_ID);
  const served = endpointModel.startsWith('@cf/') ? WORKERS_AI_PROVIDER_ID : name;

  return { spec: `${served}/${endpointModel}`, endpoint: { name, baseURL, headers: { 'Authorization': auth }, model: endpointModel }, missing: null };
}

/** The model this machine uses where none is chosen, as a result a readiness view reads; see
 *  {@link usableModelDefaults} and {@link requireModelDefaults} for the paths that must run one. */
export function resolveModelDefaults(opts?: ModelChoice): LocalModelDefaults {
  const file = loadConfigFile();
  const { baseURL, auth, model } = chosenModel(opts);

  if (baseURL && auth) return givenEndpoint(baseURL, auth, model);

  // The signed-in account is the default path and owns native model families (`workers-ai`, `my-gateway`, `@cf/`);
  // a local endpoint would accept those ids and serve something else. Explicitly picked BYO models still win.
  const signedIn = resolveCloudSession() !== null;
  const workersAi = `${WORKERS_AI_PROVIDER_ID}/${workersAIModelId(model)}`;

  if (signedIn && (!model || isNativeCloudSpec(model))) return { spec: workersAi, endpoint: null, missing: null };

  const spec = credentialedSpec(file, model) ?? (signedIn ? workersAi : null);

  const missing = spec === null && baseURL && !auth
    ? 'A base URL is set (--base-url or KINU_BASE_URL) but no auth header (--auth or KINU_AUTH).\n'
      + '  Set both, or unset the base URL and run kinu setup to pick a model provider.'
    : null;

  return { spec, endpoint: null, missing };
}

/** For a path that runs a model: the defaults, or what an incomplete setup lacks, refused. */
export function usableModelDefaults(opts?: ModelChoice): LocalModelDefaults {
  const defaults = resolveModelDefaults(opts);

  if (defaults.missing !== null) throw new Error(defaults.missing);

  return defaults;
}

/** For seams that must name a model before any is chosen (workspace creation); the failure names every fix. */
export function requireModelDefaults(opts?: Parameters<typeof resolveModelDefaults>[0]): LocalModelDefaults {
  const defaults = usableModelDefaults(opts);

  if (defaults.spec !== null) return defaults;
  throw new Error(
    'No model is set up.\n' +
    '  Run kinu auth to use Workers AI in your Cloudflare account,\n' +
    '  run kinu setup to pick a model provider,\n' +
    '  run kinu provider connect claude to use your Claude subscription,\n' +
    '  or pass --base-url and --auth to use your own endpoint.'
  );
}

export function resolveProviderCredentials(): LocalProviderCredentials {
  const file = loadConfigFile();

  return {
    // Read from the names core withholds from every command (`PROVIDER_KEY_ENV`).
    openaiApiKey: process.env[PROVIDER_KEY_ENV.openaiApiKey] ?? file.providers?.openai?.apiKey,
    anthropicApiKey: process.env[PROVIDER_KEY_ENV.anthropicApiKey] ?? file.providers?.anthropic?.apiKey,
    openrouterApiKey: process.env[PROVIDER_KEY_ENV.openrouterApiKey] ?? file.providers?.openrouter?.apiKey,
    openaiCompat: file.providers?.openaiCompat === undefined ? undefined
      : Object.fromEntries(Object.entries(file.providers.openaiCompat).map(([name, compat]) => [name, compatCredential(compat)])),
    apiKeyAccounts: localApiKeyAccounts(file),
  };
}

/** `extraHeaders` overrides the API key's Authorization, as core's credential contract declares. */
function compatCredential(compat: v.InferOutput<typeof OpenAiCompatConfigSchema>): OpenAICompatCredential {
  return {
    kind: 'openai-compat',
    baseURL: compat.baseURL,
    ...(compat.apiKey !== undefined && { apiKey: compat.apiKey }),
    extraHeaders: compat.extraHeaders,
    ...(compat.contextWindow !== undefined && { contextWindow: compat.contextWindow }),
  };
}

function compatHeaders(compat: v.InferOutput<typeof OpenAiCompatConfigSchema>) {
  return credentialToHeaders('openai-compat.default', compatCredential(compat));
}

export const API_KEY_PROVIDERS = { openai: 'openai.bearer', anthropic: 'anthropic.bearer', openrouter: 'openrouter.bearer' } as const;

function localApiKeyAccounts(file: KinuConfig): LocalProviderCredentials['apiKeyAccounts'] {
  const keys: Record<string, string> = {};

  for (const provider of ['openai', 'anthropic', 'openrouter'] as const) {
    for (const [account, stored] of Object.entries(file.providers?.[provider]?.accounts ?? {})) {
      keys[accountCredentialKey(API_KEY_PROVIDERS[provider], account)] = stored.apiKey;
    }
  }

  return keys;
}

export function createOAuthStore(fetchFn?: typeof fetch): LocalOAuthStore {
  return createFileOAuthStore(CONFIG_PATH, { fetch: fetchFn });
}

export function resolveMcpServers(): Record<string, McpServerConfig> {
  return loadConfigFile().mcpServers ?? {};
}

/**
 * The spec `model` names on this machine's credentials, or the one they suggest where none is named: a family the
 * registry serves from its own login (Claude's, opencode's), a bare id on ChatGPT's or OpenAI's account, a spec of a
 * provider whose key is connected, or the configured OpenAI-compatible endpoint's. Null when no credential serves it.
 */
function credentialedSpec(file: KinuConfig, model: string | undefined): string | null {
  const wanted = model ?? preferredModelFromCredentials(file);

  if (wanted?.startsWith('claude/') || wanted?.startsWith('opencode/')) return wanted;

  return accountSpec(file, wanted) ?? keyedSpec(file, wanted) ?? compatSpec(file, wanted);
}

/** The key a provider's calls carry: the environment's, over the config's. */
function apiKeyOf(file: KinuConfig, provider: 'openai' | 'openrouter' | 'anthropic'): string | undefined {
  return process.env[PROVIDER_KEY_ENV[`${provider}ApiKey`]] ?? file.providers?.[provider]?.apiKey;
}

/** A bare id, or no choice, on ChatGPT's login or OpenAI's key, in that order; either's own spec too. */
function accountSpec(file: KinuConfig, wanted: string | undefined): string | null {
  const takes = (provider: string): boolean => !wanted || wanted.startsWith(`${provider}/`) || !wanted.includes('/');

  if (file.providers?.chatgpt?.accessToken !== undefined && takes('chatgpt')) {
    return `chatgpt/${stripProvider(wanted ?? CHATGPT_DEFAULT_MODEL, 'chatgpt')}`;
  }

  if (apiKeyOf(file, 'openai') && takes('openai')) return `openai/${stripProvider(wanted ?? OPENAI_DEFAULT_MODEL, 'openai')}`;

  return null;
}

/** A spec of OpenRouter or Anthropic, whose key is connected. */
function keyedSpec(file: KinuConfig, wanted: string | undefined): string | null {
  return (['openrouter', 'anthropic'] as const).some((provider) => apiKeyOf(file, provider) && wanted?.startsWith(`${provider}/`))
    ? wanted ?? null
    : null;
}

/** The configured OpenAI-compatible endpoint's model. A local Ollama accepts `@cf/deepseek-ai/…` as a model name and
 *  serves something else, so a native spec is never its. */
function compatSpec(file: KinuConfig, wanted: string | undefined): string | null {
  if (!file.providers?.openaiCompat?.default || !wanted || isNativeCloudSpec(wanted)) return null;

  return `openai-compat/${stripProvider(wanted, 'openai-compat')}`;
}

export async function firstOpenAiCompatModel(): Promise<string | null> {
  const compat = loadConfigFile().providers?.openaiCompat?.default;

  if (compat === undefined) return null;

  let first: ModelInfo | undefined;

  try {
    [first] = await discoverOpenAICompatibleModels({ baseURL: compat.baseURL, headers: compatHeaders(compat) });
  } catch (cause) {
    throw new Error(`Could not list the models of the OpenAI-compatible endpoint at ${compat.baseURL}.`, { cause });
  }

  if (first === undefined) {
    throw new Error(`The OpenAI-compatible endpoint at ${compat.baseURL} lists no models and none is named: run kinu provider connect openai-compatible.`);
  }

  return `openai-compat/${first.id}`;
}

function preferredModelFromCredentials(file: KinuConfig): string | undefined {
  if (file.providers?.chatgpt?.accessToken) return `chatgpt/${CHATGPT_DEFAULT_MODEL}`;

  if (file.providers?.claude?.accessToken) return `claude/${ANTHROPIC_DEFAULT_MODEL}`;

  if (file.providers?.openai?.apiKey || process.env.OPENAI_API_KEY) return `openai/${OPENAI_DEFAULT_MODEL}`;

  if (file.providers?.openrouter?.apiKey || process.env.OPENROUTER_API_KEY) return `openrouter/${OPENROUTER_DEFAULT_MODEL}`;

  if (file.providers?.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY) return `anthropic/${ANTHROPIC_DEFAULT_MODEL}`;

  return undefined;
}

function workersAIModelId(model: string | undefined): string {
  const stripped = stripProvider(model ?? '', WORKERS_AI_PROVIDER_ID);

  if (stripped !== (model ?? '')) return stripped || DEFAULT_WORKERS_AI_MODEL_ID;

  return model?.startsWith(WORKERS_AI_MODEL_ID_PREFIX) ? model : DEFAULT_WORKERS_AI_MODEL_ID;
}

function isNativeCloudSpec(model: string): boolean {
  return model.startsWith(WORKERS_AI_MODEL_ID_PREFIX)
    || CLOUD_PROXY_PROVIDER_IDS.some((id) => model.startsWith(`${id}/`));
}

function directEndpointModelId(model: string): string {
  if (model.startsWith('workers-ai/')) return model.slice('workers-ai/'.length);

  if (model.startsWith('openai/')) return model.slice('openai/'.length);

  if (model.startsWith('openrouter/')) return model.slice('openrouter/'.length);

  if (model.startsWith('openai-compat/')) return model.slice('openai-compat/'.length);

  if (model.startsWith('opencode/')) return model.slice('opencode/'.length);

  return model;
}
