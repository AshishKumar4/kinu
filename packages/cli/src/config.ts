import {
  chmodSync, existsSync, readFileSync, mkdirSync, readdirSync, realpathSync, statSync,
  writeFileSync, unlinkSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  ANTHROPIC_BASE_URL,
  ANTHROPIC_DEFAULT_MODEL,
  CODEX_BASE_URL,
  CODEX_DEFAULT_MODEL,
  DEFAULT_WORKERS_AI_MODEL_ID,
  WORKERS_AI_PROVIDER_ID, WORKERS_AI_MODEL_ID_PREFIX,
  OPENAI_BASE_URL,
  OPENAI_DEFAULT_MODEL,
  OPENROUTER_BASE_URL,
  JsonObjectSchema, accountCredentialKey, openWorkspaceMainActor, discoverOpenAICompatibleModels, specWithoutAccount,
  ProfileCatalogEnvelopeSchema,
  type JsonObject,
  type LLMProviderConfig,
  type ModelInfo,
  type ProfileCatalogEnvelope,
  shellQuote,
} from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';
import {
  makeSql, CLOUD_PROXY_PROVIDER_IDS,
  cloudProxyBaseURL,
  createFileOAuthStore,
  ensureSecretDir,
  kinuHome,
  stripProvider,
  withConfigLock,
  writeSecretFile,
  type LocalCloudSession,
  type LocalOAuthStore,
  type LocalProviderCredentials,
  type McpServerConfig,
} from '@kinu.run/cli-backend';
import * as v from 'valibot';

export const AGENT_HOME = kinuHome();

export const CONFIG_PATH = join(AGENT_HOME, 'config.json');

export const BIN_DIR = join(AGENT_HOME, 'bin');

const KINU_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const RESERVED_ALIASES = new Set([
  'kinu',
  'create',
  'auth',
  'whoami',
  'logout',
  'setup',
  'provider',
  'providers',
  'run',
  'exec',
  'tokens',
  'chat',
  'evolve',
  'status',
  'effort',
  'list',
  'workspace',
  'alias',
  'unalias',
  'aliases',
  'transcripts',
  'desktop',
  'daemon',
  'connect',
  'export',
  'import',
  'update',
  'uninstall',
  'doctor',
]);

const DEFAULT_ORIGIN = 'https://kinu.run';

export type AgentMode = 'local' | 'cloud';

export interface KinuAgentConfig {
  name: string;
  mode: AgentMode;
  /** Cloud workspaces only; a local agent's title lives in its own database (`actor_config.display_name`). */
  displayName?: string;
  alias?: string;
  localName?: string;
  cloudName?: string;
  /** Canonical project directory; the agent's file and shell plane binds here. */
  cwd?: string;
  /** Label grouping peer agents inside `cwd`, never a directory: state stays at `~/.kinu/<name>`. */
  workspaceId?: string;
  /** `workspace_identity.id` of the addressed database, so a reused name cannot re-point the ref. */
  identityId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KinuConfig {
  origin?: string;
  accessToken?: string;
  tokenExpiresAt?: string;
  user?: { id: string; email: string; displayName?: string | null };
  agents?: Record<string, KinuAgentConfig>;
  aliases?: Record<string, string>;
  updateCheck?: boolean;
  updateCheckedAt?: number;
  updateLatestSeen?: string;
  providers?: {
    openai?: LocalApiKeyProvider;
    anthropic?: LocalApiKeyProvider;
    openrouter?: LocalApiKeyProvider;
    codex?: LocalOAuthSession & { accounts?: Record<string, LocalOAuthSession> };
    claude?: LocalOAuthSession & { accounts?: Record<string, LocalOAuthSession> };
    openaiCompat?: Record<string, {
      baseURL: string;
      apiKey?: string;
      headers?: Record<string, string>;
      extraHeaders?: Record<string, string>;
    }>;
  };
  mcpServers?: Record<string, McpServerConfig>;
  deviceConnectPromptDismissed?: boolean;
  /** Shadow-git checkpoints kept per working directory (default 50). */
  checkpointKeep?: number;
  /**
   * Bumped on every provider change so resident sessions in other processes know to re-sweep their cached listing.
   * Only inequality is read; absent reads as 0.
   */
  providerRevision?: number;
  /** Failed server-side logout. The raw token is the only copy (the server stores a hash); kept until a retry confirms revocation. */
  pendingRevocation?: { token: string; origin: string; at: number };
  /** Signed-out profile authority; never holds account data. */
  localProfile?: ProfileCatalogEnvelope;
}

export interface LocalApiKeyProvider {
  apiKey?: string;
  accounts?: Record<string, { apiKey: string }>;
}

export interface LocalOAuthSession {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  metadata?: JsonObject;
}

export interface CloudAuthConfig {
  origin: string;
  token: string;
  user?: KinuConfig['user'];
}

const StringMapSchema = v.record(v.string(), v.string());

const KinuAgentConfigSchema = v.object({
  name: v.string(),
  mode: v.picklist(['local', 'cloud']),
  displayName: v.optional(v.string()),
  alias: v.optional(v.string()),
  localName: v.optional(v.string()),
  cloudName: v.optional(v.string()),
  cwd: v.optional(v.string()),
  workspaceId: v.optional(v.string()),
  identityId: v.optional(v.string()),
  createdAt: v.string(),
  updatedAt: v.string(),
});

const McpServerConfigSchema = v.object({
  command: v.string(),
  args: v.optional(v.array(v.string())),
  env: v.optional(StringMapSchema),
  timeoutMs: v.optional(v.number()),
});

const OpenAiCompatConfigSchema = v.object({
  baseURL: v.string(),
  apiKey: v.optional(v.string()),
  headers: v.optional(StringMapSchema),
  extraHeaders: v.optional(StringMapSchema),
});

const LocalApiKeyProviderSchema = v.object({
  apiKey: v.optional(v.string()),
  accounts: v.optional(v.record(v.string(), v.object({ apiKey: v.string() }))),
});

const LocalOAuthSessionSchema = v.object({
  accessToken: v.optional(v.string()),
  refreshToken: v.optional(v.string()),
  expiresAt: v.optional(v.number()),
  metadata: v.optional(JsonObjectSchema),
});

const KinuConfigSchema: v.GenericSchema<KinuConfig> = v.object({
  origin: v.optional(v.string()),
  accessToken: v.optional(v.string()),
  tokenExpiresAt: v.optional(v.string()),
  user: v.optional(v.object({
    id: v.string(),
    email: v.string(),
    displayName: v.optional(v.nullable(v.string())),
  })),
  agents: v.optional(v.record(v.string(), KinuAgentConfigSchema)),
  aliases: v.optional(StringMapSchema),
  updateCheck: v.optional(v.boolean()),
  updateCheckedAt: v.optional(v.number()),
  updateLatestSeen: v.optional(v.string()),
  providers: v.optional(v.object({
    openai: v.optional(LocalApiKeyProviderSchema),
    anthropic: v.optional(LocalApiKeyProviderSchema),
    openrouter: v.optional(LocalApiKeyProviderSchema),
    codex: v.optional(v.object({
      ...LocalOAuthSessionSchema.entries,
      accounts: v.optional(v.record(v.string(), LocalOAuthSessionSchema)),
    })),
    claude: v.optional(v.object({
      ...LocalOAuthSessionSchema.entries,
      accounts: v.optional(v.record(v.string(), LocalOAuthSessionSchema)),
    })),
    openaiCompat: v.optional(v.record(v.string(), OpenAiCompatConfigSchema)),
  })),
  mcpServers: v.optional(v.record(v.string(), McpServerConfigSchema)),
  deviceConnectPromptDismissed: v.optional(v.boolean()),
  checkpointKeep: v.optional(v.number()),
  providerRevision: v.optional(v.number()),
  pendingRevocation: v.optional(v.object({
    token: v.string(),
    origin: v.string(),
    at: v.number(),
  })),
  localProfile: v.optional(ProfileCatalogEnvelopeSchema),
});

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

interface LocalAgentRef {
  name: string;
  cwd: string;
  workspaceId: string;
  dbPath: string;
}

/** `adopted`: this resolve bound an unplaced `~/.kinu/<name>` workspace to the caller's project. */
type LocalPlacement = 'recorded' | 'adopted' | 'unplaced';

export interface ResolvedLocalAgent extends LocalAgentRef {
  placement: LocalPlacement;
}

/** Null without a recorded placement, so an unplaced workspace belongs to no project rather than to the current directory. */
function placedRef(agent: KinuAgentConfig): LocalAgentRef | null {
  if (agent.mode !== 'local' || !agent.cwd || !agent.workspaceId) return null;

  // A missing recorded directory places nothing; otherwise a renamed project's agents would vanish from every roster.
  if (!existsSync(agent.cwd)) return null;
  const name = agent.localName ?? agent.name;

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

/** Unplaced workspaces are not attributed here: attribution is adoption, and adoption is per-agent. */
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

/** `~/.kinu/<name>` directories with an `agent.db` that no ref places; adopted one at a time. */
export function listUnplacedAgentNames(): string[] {
  if (!existsSync(AGENT_HOME)) return [];
  const placed = new Set(listLocalRefsAllProjects().map((ref) => ref.name));

  return readdirSync(AGENT_HOME)
    .filter((name) => KINU_IDENTIFIER_RE.test(name)
      && !placed.has(name)
      && existsSync(join(AGENT_HOME, name, 'agent.db')))
    .sort();
}

export function readWorkspaceIdentityId(dbPath: string): string | null {
  if (!existsSync(dbPath)) return null;
  // Read-write although nothing writes: a WAL database needs its `-shm`, and a readonly connection may not build one.
  const db = new Database(dbPath);

  try {
    const present = db.query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'workspace_identity'`,
    ).get();

    if (!present || present.n === 0) return null;
    const row = db.query<{ id: string }, []>(`SELECT id FROM workspace_identity LIMIT 1`).get();

    if (row?.id) return row.id;

    return null;
  } finally {
    db.close();
  }
}

/** The only label source for local agents; config.json holds no copy, so renames cannot drift. */
export function readWorkspaceDisplayName(dbPath: string): string | null {
  if (!existsSync(dbPath)) return null;
  // Read-write: see `readWorkspaceIdentityId`.
  const db = new Database(dbPath);

  try {
    const present = db.query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'actor_config'`,
    ).get();

    if (!present || present.n === 0) return null;

    return openWorkspaceMainActor(makeSql(db)).config.getDisplayName();
  } finally {
    db.close();
  }
}

interface AdoptUnplacedAgentOptions {
  cwd?: string;
  workspaceId?: string;
}

/** Binds one named workspace, keyed on its own identity, so nothing sweeps every unplaced directory. Placed refs return unchanged. */
export async function adoptUnplacedLocalAgent(name: string, opts: AdoptUnplacedAgentOptions = {}): Promise<LocalAgentRef> {
  const dbPath = agentDbPath(name);

  if (!existsSync(dbPath)) {
    throw new Error(`Workspace "${name}" not found at ${dbPath}.`);
  }

  const existing = loadConfigFile().agents?.[name];

  if (existing && existing.mode !== 'local') {
    throw new Error(`"${name}" is already configured as a cloud workspace.`);
  }

  const already = existing ? placedRef(existing) : null;

  if (already) return already;
  const cwd = canonicalProjectRoot(opts.cwd);
  const workspaceId = opts.workspaceId ?? defaultVirtualWorkspaceId(cwd);
  await upsertAgentConfig({
    ...existing,
    name,
    mode: 'local',
    localName: name,
    cwd,
    workspaceId,
    identityId: readWorkspaceIdentityId(dbPath) ?? undefined,
  });

  return { name, cwd, workspaceId, dbPath };
}

export class MissingLocalWorkspaceError extends Error {
  readonly hint: string;

  constructor(workspaceName: string) {
    super(`Workspace "${workspaceName}" not found.`);
    this.name = 'MissingLocalWorkspaceError';
    this.hint = `Create it with: kinu create ${workspaceName}`;
  }
}

export interface ResolveLocalAgentOptions {
  cwd?: string;
  workspaceId?: string;
  /** Pass false for a read that must not change configuration. */
  adopt?: boolean;
}

/** The one local resolution, so the placement a peer group depends on cannot drift between call sites. */
export async function resolveLocalAgent(input: string, opts: ResolveLocalAgentOptions = {}): Promise<ResolvedLocalAgent> {
  const ref = resolveAgentRef(input);

  if (ref && ref.mode !== 'local') {
    throw new Error(`"${input}" is a cloud workspace; this needs a local one.`);
  }

  const name = ref?.localName ?? ref?.name ?? input;
  const dbPath = agentDbPath(name);

  if (!existsSync(dbPath)) throw new MissingLocalWorkspaceError(name);
  const placed = ref ? placedRef(ref) : null;

  if (ref && placed) {
    assertIdentityUnchanged(ref, placed);

    return { ...placed, placement: 'recorded' };
  }

  const cwd = canonicalProjectRoot(opts.cwd);
  const workspaceId = opts.workspaceId ?? defaultVirtualWorkspaceId(cwd);

  if (opts.adopt === false) {
    return { name, cwd, workspaceId, dbPath, placement: 'unplaced' };
  }

  return { ...(await adoptUnplacedLocalAgent(name, { cwd, workspaceId })), placement: 'adopted' };
}

/** A changed identity means the name was reused; continuing would attach history to a different workspace. */
function assertIdentityUnchanged(agent: KinuAgentConfig, ref: LocalAgentRef): void {
  if (!agent.identityId) return;
  const actual = readWorkspaceIdentityId(ref.dbPath);

  if (actual === null || actual === agent.identityId) return;
  throw new Error(
    `Workspace "${ref.name}" at ${ref.dbPath} is not the one recorded for ${ref.cwd}: `
    + `expected identity ${agent.identityId}, found ${actual}. `
    + 'Rename one of them, or remove the stale entry from ~/.kinu/config.json.',
  );
}

export function loadConfigFile(): KinuConfig {
  if (!existsSync(CONFIG_PATH)) return {};

  try {
    return v.parse(KinuConfigSchema, JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')));
  } catch (error) {
    // Defaulting would discard the whole file over one bad field and look like a first run.
    throw new Error(`${CONFIG_PATH} is not a valid Kinu config; fix or remove it.`, { cause: error });
  }
}

function writeConfigFileUnlocked(config: KinuConfig): void {
  ensureAgentHome();
  writeSecretFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

/** The one config writer; always read-modify-write under the lock, since a blind overwrite drops other processes' writes. */
export function updateConfigFile(mutator: (config: KinuConfig) => KinuConfig | void): Promise<KinuConfig> {
  return withConfigLock(CONFIG_PATH, () => {
    const config = loadConfigFile();
    const next = mutator(config) ?? config;
    writeConfigFileUnlocked(next);

    return next;
  });
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
  return (opts?.origin ?? process.env.KINU_ORIGIN ?? loadConfigFile().origin ?? DEFAULT_ORIGIN).replace(/\/+$/, '');
}

export function requireAuthConfig(): CloudAuthConfig {
  // CI: `KINU_TOKEN` (usually a scoped `pta_…` token) wins over the stored session; the server decides validity.
  const envToken = process.env.KINU_TOKEN?.trim();

  if (envToken) return { origin: resolveCloudOrigin(), token: envToken };

  return storedAuthConfig('Not authenticated. Run: kinu auth (or set KINU_TOKEN)');
}

export function requireStoredAuthConfig(): CloudAuthConfig {
  return storedAuthConfig('No interactive CLI session found. Run: kinu auth');
}

function storedAuthConfig(missingTokenMessage: string): CloudAuthConfig {
  const config = loadConfigFile();
  const token = config.accessToken;

  if (!token) {
    throw new Error(missingTokenMessage);
  }

  if (sessionExpired(config)) {
    throw new Error('Your Kinu CLI session has expired. Run: kinu auth');
  }

  return { origin: resolveCloudOrigin(), token, user: config.user };
}

export function sessionExpired(config: KinuConfig): boolean {
  if (!config.tokenExpiresAt) return false;
  const expiresAt = Date.parse(config.tokenExpiresAt);

  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

/** `KINU_TOKEN` wins, as in requireAuthConfig. An unreadable config throws: it is not a signed-out user. */
export function resolveCloudSession(): LocalCloudSession | null {
  const envToken = process.env.KINU_TOKEN?.trim();

  if (envToken) return { origin: resolveCloudOrigin(), token: envToken };
  const config = loadConfigFile();
  const token = config.accessToken;

  if (!token || sessionExpired(config)) return null;

  return { origin: resolveCloudOrigin(), token };
}

export function resolveAgentRef(input: string): KinuAgentConfig | null {
  const config = loadConfigFile();
  const canonical = config.aliases?.[input] ?? input;

  return config.agents?.[canonical] ?? null;
}

export function listConfiguredAgentRefs(): KinuAgentConfig[] {
  return Object.values(loadConfigFile().agents ?? {})
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function upsertAgentConfig(agent: Omit<KinuAgentConfig, 'createdAt' | 'updatedAt'> & Partial<Pick<KinuAgentConfig, 'createdAt' | 'updatedAt'>>): Promise<KinuAgentConfig> {
  validateAgentName(agent.name);

  if (agent.alias) validateAliasName(agent.alias);

  if (agent.localName) validateAgentName(agent.localName);

  if (agent.cloudName) validateAgentName(agent.cloudName);

  if (agent.workspaceId) validateWorkspaceId(agent.workspaceId);
  const now = new Date().toISOString();
  let saved!: KinuAgentConfig;
  await updateConfigFile((config) => {
    const existing = config.agents?.[agent.name];
    saved = {
      ...existing,
      ...agent,
      createdAt: agent.createdAt ?? existing?.createdAt ?? now,
      updatedAt: now,
    };
    config.agents = { ...config.agents, [agent.name]: saved };
  });

  return saved;
}

export async function removeCloudAgentConfig(cloudName: string): Promise<boolean> {
  let removed = false;
  await updateConfigFile((config) => {
    const agents = config.agents ?? {};
    const removedNames = new Set<string>();

    for (const [name, agent] of Object.entries(agents)) {
      if (agent.mode !== 'cloud' || (agent.cloudName ?? agent.name) !== cloudName) continue;
      delete agents[name];
      removedNames.add(name);
      removed = true;
    }

    if (config.aliases) {
      for (const [alias, target] of Object.entries(config.aliases)) {
        if (removedNames.has(target)) delete config.aliases[alias];
      }
    }

    config.agents = agents;
  });

  return removed;
}

async function setAliasConfig(agentName: string, alias: string): Promise<void> {
  validateAgentName(agentName);
  validateAliasName(alias);
  await updateConfigFile((config) => {
    config.aliases = { ...config.aliases, [alias]: agentName };
    const existing = config.agents?.[agentName];

    if (existing) {
      config.agents = {
        ...config.agents,
        [agentName]: { ...existing, alias, updatedAt: new Date().toISOString() },
      };
    }
  });
}

async function removeAliasConfig(alias: string): Promise<void> {
  await updateConfigFile((config) => {
    const agentName = config.aliases?.[alias];

    if (config.aliases) delete config.aliases[alias];

    if (agentName && config.agents?.[agentName]?.alias === alias) {
      config.agents[agentName] = { ...config.agents[agentName], alias: undefined, updatedAt: new Date().toISOString() };
    }
  });
}

function aliasPath(alias: string): string {
  validateAliasName(alias);

  return join(BIN_DIR, alias);
}

export async function writeAliasShim(agentName: string, alias: string): Promise<string> {
  validateAgentName(agentName);
  validateAliasName(alias);
  ensureBinDir();
  const path = aliasPath(alias);

  const script = `#!/usr/bin/env sh
set -eu
bin_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$bin_dir/kinu" run ${shellQuote(agentName)} "$@"
`;

  writeFileSync(path, script, { mode: 0o755 });
  chmodSync(path, 0o755);
  await setAliasConfig(agentName, alias);

  return path;
}

export async function deleteAliasShim(alias: string): Promise<void> {
  validateAliasName(alias);
  tolerate(() => unlinkSync(aliasPath(alias)), 'enoent');
  await removeAliasConfig(alias);
}

export function pathHint(): string | null {
  return (process.env.PATH ?? '').split(':').includes(BIN_DIR) ? null : `Add ${BIN_DIR} to PATH for kinu aliases.`;
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

function validateAliasName(alias: string): void {
  validateIdentifier(alias, 'Alias');

  if (RESERVED_ALIASES.has(alias)) {
    throw new Error(`Alias "${alias}" is reserved. Choose another alias.`);
  }
}

/** Default endpoint for bare model ids, null when nothing derives one; see {@link requireLLMConfig}. */
export function resolveLLMConfig(opts?: {
  model?: string;
  baseUrl?: string;
  auth?: string;
  defaultModel?: string;
}): LLMProviderConfig | null {
  const file = loadConfigFile();

  const baseURL = opts?.baseUrl
    ?? process.env.KINU_BASE_URL
    ?? process.env.AI_GATEWAY_BASE_URL;

  const auth = opts?.auth
    ?? process.env.KINU_AUTH
    ?? process.env.AI_GATEWAY_AUTH;

  const named = opts?.model
    ?? process.env.KINU_MODEL
    ?? process.env.AI_GATEWAY_MODEL
    ?? opts?.defaultModel;

  const model = named === undefined ? undefined : specWithoutAccount(named);

  if (baseURL && auth) {
    return {
      name: model?.startsWith('@cf/') ? 'workers-ai' : 'openai-compat',
      baseURL,
      headers: { 'Authorization': auth },
      model: directEndpointModelId(model ?? DEFAULT_WORKERS_AI_MODEL_ID),
    };
  }

  const cloud = resolveCloudSession();

  // The signed-in account is the default path and owns native model families (`workers-ai`, `my-gateway`, `@cf/`);
  // a local endpoint would accept those ids and serve something else. Explicitly picked BYO models still win.
  const cloudConfig: LLMProviderConfig | null = cloud
    ? {
        name: 'workers-ai',
        baseURL: cloudProxyBaseURL(cloud.origin),
        headers: { Authorization: `Bearer ${cloud.token}` },
        model: workersAIModelId(model),
      }
    : null;

  if (cloudConfig && (!model || isNativeCloudSpec(model))) return cloudConfig;

  // An explicit registry-only spec resolves to that family ahead of any credential default.
  const family = registryFamilyMarker(model ?? preferredModelFromCredentials(file));

  if (family) return family;

  const derived = deriveLLMConfigFromProviderCredentials(file, model);

  if (derived) return derived;

  if (cloudConfig) return cloudConfig;

  if (baseURL && !auth) {
    throw new Error(
      'A base URL is set (--base-url or KINU_BASE_URL) but no auth header (--auth or KINU_AUTH).\n' +
      '  Set both, or unset the base URL and run kinu setup to pick a model provider.'
    );
  }

  return null;
}

/** For seams that must hand core an endpoint object (workspace creation, evolution); the failure names every fix. */
export function requireLLMConfig(opts?: Parameters<typeof resolveLLMConfig>[0]): LLMProviderConfig {
  const config = resolveLLMConfig(opts);

  if (config) return config;
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
    openaiApiKey: process.env.OPENAI_API_KEY ?? file.providers?.openai?.apiKey,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? file.providers?.anthropic?.apiKey,
    openrouterApiKey: process.env.OPENROUTER_API_KEY ?? file.providers?.openrouter?.apiKey,
    codexAccessToken: process.env.CODEX_ACCESS_TOKEN,
    openaiCompat: file.providers?.openaiCompat,
    apiKeyAccounts: localApiKeyAccounts(file),
  };
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

function deriveLLMConfigFromProviderCredentials(file: KinuConfig, model: string | undefined): LLMProviderConfig | null {
  const providerModel = model ?? preferredModelFromCredentials(file);

  const hasCodexCredential = [process.env.CODEX_ACCESS_TOKEN, file.providers?.codex?.accessToken, file.providers?.codex?.refreshToken]
    .some((token) => token !== undefined && token !== '');

  if (hasCodexCredential && (!providerModel || providerModel.startsWith('codex/') || !providerModel.includes('/'))) {
    return {
      name: 'codex',
      baseURL: CODEX_BASE_URL,
      headers: {},
      model: stripProvider(providerModel ?? CODEX_DEFAULT_MODEL, 'codex'),
    };
  }

  const openaiKey = process.env.OPENAI_API_KEY ?? file.providers?.openai?.apiKey;

  if (openaiKey && (!providerModel || providerModel.startsWith('openai/') || !providerModel.includes('/'))) {
    return {
      name: 'openai',
      baseURL: OPENAI_BASE_URL,
      headers: { Authorization: `Bearer ${openaiKey}` },
      model: stripProvider(providerModel ?? OPENAI_DEFAULT_MODEL, 'openai'),
    };
  }

  const openrouterKey = process.env.OPENROUTER_API_KEY ?? file.providers?.openrouter?.apiKey;

  if (openrouterKey && providerModel?.startsWith('openrouter/')) {
    return {
      name: 'openrouter',
      baseURL: OPENROUTER_BASE_URL,
      headers: {
        Authorization: `Bearer ${openrouterKey}`,
        'X-Title': 'Kinu CLI',
      },
      model: stripProvider(providerModel, 'openrouter'),
    };
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? file.providers?.anthropic?.apiKey;

  if (anthropicKey && providerModel?.startsWith('anthropic/')) {
    return {
      name: 'anthropic',
      baseURL: ANTHROPIC_BASE_URL,
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      model: stripProvider(providerModel, 'anthropic'),
    };
  }

  const compat = file.providers?.openaiCompat?.default;

  // A local Ollama accepts `@cf/deepseek-ai/…` as a model name and serves something else.
  if (compat && providerModel && !isNativeCloudSpec(providerModel)) {
    return {
      name: 'openai-compat',
      baseURL: compat.baseURL,
      headers: openAiCompatHeaders(compat),
      model: stripProvider(providerModel, 'openai-compat'),
    };
  }

  return null;
}

function openAiCompatHeaders(compat: v.InferOutput<typeof OpenAiCompatConfigSchema>): Record<string, string> {
  const headers = { ...compat.headers };

  if (compat.apiKey) headers.Authorization = `Bearer ${compat.apiKey}`;

  return Object.assign(headers, compat.extraHeaders);
}

export async function firstOpenAiCompatModel(): Promise<string | null> {
  const compat = loadConfigFile().providers?.openaiCompat?.default;

  if (compat === undefined) return null;

  let first: ModelInfo | undefined;

  try {
    [first] = await discoverOpenAICompatibleModels({ baseURL: compat.baseURL, headers: openAiCompatHeaders(compat) });
  } catch (cause) {
    throw new Error(`Could not list the models of the OpenAI-compatible endpoint at ${compat.baseURL}.`, { cause });
  }

  if (first === undefined) {
    throw new Error(`The OpenAI-compatible endpoint at ${compat.baseURL} lists no models and none is named: run kinu provider connect openai-compatible.`);
  }

  return `openai-compat/${first.id}`;
}

/** Families the registry serves from their own logins (Claude's, opencode's auth.json); the endpoint is only a marker. */
function registryFamilyMarker(model: string | undefined): LLMProviderConfig | null {
  if (!model) return null;

  if (model.startsWith('claude/')) {
    return { name: 'claude', baseURL: '', headers: {}, model: stripProvider(model, 'claude') };
  }

  if (model.startsWith('opencode/')) {
    return { name: 'opencode', baseURL: '', headers: {}, model: stripProvider(model, 'opencode') };
  }

  return null;
}

function preferredModelFromCredentials(file: KinuConfig): string | undefined {
  if (file.providers?.codex?.accessToken || file.providers?.codex?.refreshToken || process.env.CODEX_ACCESS_TOKEN) return `codex/${CODEX_DEFAULT_MODEL}`;

  if (file.providers?.claude?.accessToken) return `claude/${ANTHROPIC_DEFAULT_MODEL}`;

  if (file.providers?.openai?.apiKey || process.env.OPENAI_API_KEY) return `openai/${OPENAI_DEFAULT_MODEL}`;

  if (file.providers?.openrouter?.apiKey || process.env.OPENROUTER_API_KEY) return 'openrouter/openai/gpt-4o-mini';

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
