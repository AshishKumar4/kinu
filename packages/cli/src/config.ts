/**
 * CLI configuration. App auth is stored in ~/.kinu/config.json after
 * `kinu setup`; direct LLM env vars remain as explicit local overrides.
 */

import {
  chmodSync, existsSync, readFileSync, mkdirSync, readdirSync, realpathSync,
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
  JsonObjectSchema,
  ProfileCatalogEnvelopeSchema,
  type JsonObject,
  type LLMProviderConfig,
  type ProfileCatalogEnvelope,
  type ReasoningEffort,
} from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';
import {
  CLOUD_PROXY_PROVIDER_IDS,
  cloudProxyBaseURL,
  createFileCodexAuthStore,
  ensureSecretDir,
  kinuHome,
  withConfigLock,
  writeSecretFile,
  type LocalCloudSession,
  type LocalCodexAuthStore,
  type LocalProviderCredentials,
  type McpServerConfig,
} from '@kinu.run/cli-backend';
import * as v from 'valibot';

export const AGENT_HOME = kinuHome();
export const CONFIG_PATH = join(AGENT_HOME, 'config.json');
export const BIN_DIR = join(AGENT_HOME, 'bin');
const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
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
  /** Cloud workspaces only: the server-side title cache. A local agent's
   *  title lives in its own database (`agent_config.display_name`) and is
   *  never mirrored here. */
  displayName?: string;
  alias?: string;
  localName?: string;
  cloudName?: string;
  /** Canonical physical project directory this local agent works in. Recorded
   *  at creation; its file and shell plane binds here. */
  cwd?: string;
  /** Virtual workspace label grouping peer agents inside `cwd`. Metadata: it
   *  names a group, never a directory — state stays at `~/.kinu/<name>`. */
  workspaceId?: string;
  /** `workspace_identity.id` of the database this ref addresses, so a reused
   *  name cannot silently re-point the ref at a different workspace. */
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
  model?: string;
  reasoningEffort?: ReasoningEffort;
  /** Set false to silence the once-a-day "newer Kinu available" notice. */
  updateCheck?: boolean;
  /** Throttle state for that notice — never a version source, just a cache. */
  updateCheckedAt?: number;
  updateLatestSeen?: string;
  providers?: {
    openai?: { apiKey?: string };
    anthropic?: { apiKey?: string };
    openrouter?: { apiKey?: string };
    codex?: {
      accessToken?: string;
      refreshToken?: string;
      expiresAt?: number;
      metadata?: JsonObject;
    };
    openaiCompat?: Record<string, {
      baseURL: string;
      apiKey?: string;
      headers?: Record<string, string>;
      extraHeaders?: Record<string, string>;
    }>;
  };
  /** Stdio MCP servers to connect locally (standard mcpServers shape). */
  mcpServers?: Record<string, McpServerConfig>;
  /** "Don't ask again" for the chat device-connect prompt. */
  deviceConnectPromptDismissed?: boolean;
  /** Shadow-git file checkpoints kept per working directory (default 50). */
  checkpointKeep?: number;
  /**
   * How many times this machine's PROVIDER configuration has changed — every
   * credential connected, revoked, or signed in or out advances it by one.
   *
   * It exists to cross a process boundary. A resident daemon or a live chat
   * session caches the provider listing and invalidates it by signal rather
   * than by time, and `kinu provider connect` runs in a different process
   * entirely, so nothing in the resident one is there to raise that signal.
   * This counter is what it reads instead: a number that differs from the one
   * its cached listing was measured under means sweep again.
   *
   * Monotonic and meaningless in absolute terms — only inequality is read, so
   * there is no clock here and nothing expires. Absent reads as 0, which is the
   * correct baseline for a machine that has never changed a provider.
   */
  providerRevision?: number;
  /**
   * A server-side logout this machine could not complete. The raw token is the
   * ONLY copy — the server stores a hash — so it stays here until a retry
   * confirms the revocation, because deleting it would orphan a live 180-day
   * bearer with nothing able to name it.
   */
  pendingRevocation?: { token: string; origin: string; at: number };
  /** Signed-out profile authority: the one local envelope, canonical when
   *  no account session governs this machine. Never holds account data. */
  localProfile?: ProfileCatalogEnvelope;
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
  model: v.optional(v.string()),
  reasoningEffort: v.optional(v.picklist(['low', 'medium', 'high'])),
  updateCheck: v.optional(v.boolean()),
  updateCheckedAt: v.optional(v.number()),
  updateLatestSeen: v.optional(v.string()),
  providers: v.optional(v.object({
    openai: v.optional(v.object({ apiKey: v.optional(v.string()) })),
    anthropic: v.optional(v.object({ apiKey: v.optional(v.string()) })),
    openrouter: v.optional(v.object({ apiKey: v.optional(v.string()) })),
    codex: v.optional(v.object({
      accessToken: v.optional(v.string()),
      refreshToken: v.optional(v.string()),
      expiresAt: v.optional(v.number()),
      metadata: v.optional(JsonObjectSchema),
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

/** The canonical physical project directory: one identity per project, so two
 *  spellings of the same directory are not two projects.
 *
 *  A directory that is not there has no canonical form, and the absolute path is
 *  the honest answer for it — a project whose directory was moved or removed has
 *  to read as a different place, not abort the command with a bare `lstat`. */
export function canonicalProjectRoot(cwd = process.cwd()): string {
  const absolute = resolve(cwd);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

/** A project's default virtual-workspace label — its directory name, slugged.
 *  A label grouping peer agents, never a path segment. */
export function defaultVirtualWorkspaceId(cwd = process.cwd()): string {
  const candidate = basename(canonicalProjectRoot(cwd))
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return candidate && AGENT_NAME_RE.test(candidate) ? candidate : 'workspace';
}

/** The one owner of local agent state paths. Nothing else joins AGENT_HOME
 *  with an agent name. A virtual workspace groups these; it never nests them. */
export function agentDir(name: string): string {
  validateAgentName(name);
  return join(AGENT_HOME, name);
}

export function agentDbPath(name: string): string {
  return join(agentDir(name), 'agent.db');
}

/** A local agent placed in a project: the directory its file and shell plane
 *  binds to, and the virtual workspace grouping it with its peers. */
export interface LocalAgentRef {
  name: string;
  cwd: string;
  workspaceId: string;
  dbPath: string;
}

/** `recorded` — placement written when the agent was created. `adopted` — this
 *  resolve bound a legacy `~/.kinu/<name>` workspace to the caller's project.
 *  `unplaced` — read without binding anything. */
export type LocalPlacement = 'recorded' | 'adopted' | 'unplaced';

export interface ResolvedLocalAgent extends LocalAgentRef {
  placement: LocalPlacement;
}

/** The ref as a placed local agent, or null when it records no placement —
 *  which is what makes a legacy workspace belong to no project, rather than to
 *  whichever directory the CLI happened to start in. */
function placedRef(agent: KinuAgentConfig): LocalAgentRef | null {
  if (agent.mode !== 'local' || !agent.cwd || !agent.workspaceId) return null;
  // A recorded directory that no longer exists places nothing: the planes cannot
  // bind to it, and treating the ref as placed anyway would drop the agent out
  // of both this listing and the unplaced one, which is how renaming a project
  // directory would make its agents disappear from every roster.
  if (!existsSync(agent.cwd)) return null;
  const name = agent.localName ?? agent.name;
  if (!AGENT_NAME_RE.test(name)) return null;
  return {
    name,
    cwd: agent.cwd,
    workspaceId: agent.workspaceId,
    dbPath: agentDbPath(name),
  };
}

/** Every placed local ref, in any project. The machine-wide view: a scheduler
 *  must not be scoped to the directory it was launched from. */
export function listLocalRefsAllProjects(): LocalAgentRef[] {
  return Object.values(loadConfigFile().agents ?? {})
    .map(placedRef)
    .filter((ref): ref is LocalAgentRef => ref !== null && existsSync(ref.dbPath))
    .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId) || a.name.localeCompare(b.name));
}

/** One project's refs. A legacy workspace with no recorded placement is NOT
 *  attributed here — attribution is adoption, and adoption is per-agent. */
function listLocalRefs(cwd = process.cwd()): LocalAgentRef[] {
  const root = canonicalProjectRoot(cwd);
  return listLocalRefsAllProjects().filter((ref) => ref.cwd === root);
}

/** Peers: the agents sharing one project directory and one workspace label. */
export function localWorkspaceMembers(workspaceId: string, cwd = process.cwd()): LocalAgentRef[] {
  return listLocalRefs(cwd).filter((ref) => ref.workspaceId === workspaceId);
}

export function listAgentDirs(cwd = process.cwd()): string[] {
  return listLocalRefs(cwd).map((ref) => ref.name);
}

/** Local workspaces on this machine that no ref places in a project: made
 *  before placement was recorded. Readable, and adopted one at a time. */
export function listLegacyAgentNames(): string[] {
  if (!existsSync(AGENT_HOME)) return [];
  const placed = new Set(listLocalRefsAllProjects().map((ref) => ref.name));
  return readdirSync(AGENT_HOME)
    .filter((name) => AGENT_NAME_RE.test(name)
      && !placed.has(name)
      && existsSync(join(AGENT_HOME, name, 'agent.db')))
    .sort();
}

/** The durable id of a local workspace database, or null when it carries none.
 *  `agent_identity` is the pre-rename table: a local workspace is a file that
 *  outlives the rename, so adoption keys on it too. */
export function readWorkspaceIdentityId(dbPath: string): string | null {
  if (!existsSync(dbPath)) return null;
  // Opened READ-WRITE although nothing here writes. A workspace runs in WAL
  // mode, a WAL database is unreadable without the `-shm` file SQLite builds
  // beside it, and a readonly connection may not build one — so a workspace
  // whose sidecars are not on disk failed every readonly read with "unable to
  // open database file". That reached the owner's own log, reading back the
  // title of a workspace nothing had open.
  const db = new Database(dbPath);
  try {
    for (const table of ['workspace_identity', 'agent_identity']) {
      const present = db.query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`,
      ).get(table);
      if (!present || present.n === 0) continue;
      const row = db.query<{ id: string }, []>(`SELECT id FROM ${table} LIMIT 1`).get();
      if (row?.id) return row.id;
    }
    return null;
  } finally {
    db.close();
  }
}

/** The visible title a local workspace's own database carries, or null when it
 *  has none yet. The one label source for local agents: config.json holds no
 *  copy of it, so a rename or auto-title cannot drift from the roster. */
export function readWorkspaceDisplayName(dbPath: string): string | null {
  if (!existsSync(dbPath)) return null;
  // Read-write for the reason `readWorkspaceIdentityId` above states: a
  // published WAL database has no `-shm`, and only a writable connection may
  // build one.
  const db = new Database(dbPath);
  try {
    const present = db.query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'agent_config'`,
    ).get();
    if (!present || present.n === 0) return null;
    const row = db.query<{ value: string }, [string]>(
      `SELECT value FROM agent_config WHERE key = 'display_name'`,
    ).get('display_name');
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

export interface AdoptLegacyAgentOptions {
  cwd?: string;
  workspaceId?: string;
}

/**
 * Bind ONE legacy `~/.kinu/<name>` workspace to a project, keyed on that
 * database's own workspace identity. Bounded on purpose: it takes a name, so
 * nothing can sweep every legacy directory into whichever directory the CLI
 * happened to start in. An already-placed ref comes back unchanged.
 */
export function adoptLegacyLocalAgent(name: string, opts: AdoptLegacyAgentOptions = {}): LocalAgentRef {
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
  upsertAgentConfig({
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

/** A named local workspace has no database. Carries the remedy separately so
 *  a command renders it as a hint instead of folding it into the message. */
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
  /** Label to adopt an unplaced workspace into. Default: the project's own. */
  workspaceId?: string;
  /** Record the placement for an unplaced workspace. Leave it on for a real
   *  open; pass false for a read that must not change configuration. */
  adopt?: boolean;
}

/**
 * The one local resolution: the database path plus the project its file and
 * shell plane binds to. Commands call this instead of joining paths, so the
 * placement a peer group depends on cannot drift between call sites.
 */
export function resolveLocalAgent(input: string, opts: ResolveLocalAgentOptions = {}): ResolvedLocalAgent {
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
  return { ...adoptLegacyLocalAgent(name, { cwd, workspaceId }), placement: 'adopted' };
}

/** A ref is bound to one durable workspace. When the recorded identity no
 *  longer matches the database at that path the name was reused, and carrying
 *  on would attach one project's history to a different workspace. */
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
    // Defaulting silently here would discard the whole file — model, aliases, agents, session —
    // because of one bad field, and look identical to a first run.
    throw new Error(`${CONFIG_PATH} is not a valid Kinu config; fix or remove it.`, { cause: error });
  }
}

export function setDefaultModel(spec: string): void {
  const normalized = spec.trim();
  if (!normalized) throw new Error('model spec required');
  updateConfigFile((config) => { config.model = normalized; });
}

function writeConfigFileUnlocked(config: KinuConfig): void {
  ensureAgentHome();
  writeSecretFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * The ONE config writer. The mutator may edit the loaded config in place or
 * return a replacement, so a whole-file overwrite is `updateConfigFile(() =>
 * next)` under the same lock rather than a second exported entry point that
 * skips the read. There used to be one, and nothing in production called it:
 * every command here is read-modify-write, because a blind overwrite drops
 * whatever another process wrote since this one loaded.
 */
export function updateConfigFile(mutator: (config: KinuConfig) => KinuConfig | void): KinuConfig {
  return withConfigLock(CONFIG_PATH, () => {
    const config = loadConfigFile();
    const next = mutator(config) ?? config;
    writeConfigFileUnlocked(next);
    return next;
  });
}

/**
 * This machine's current provider revision — see {@link KinuConfig.providerRevision}.
 *
 * Read by every resident session at every profile resolution, so it stays a
 * plain file read and never a network call. An unreadable config throws, which
 * is right: the alternative is answering 0 for a machine whose real revision is
 * higher, and that reads as "nothing changed".
 */
export function readProviderRevision(): number {
  return loadConfigFile().providerRevision ?? 0;
}

/**
 * Publish that this machine's provider configuration changed.
 *
 * Called by every command that connects, disconnects, signs in or signs out —
 * anything that changes the set of providers a model resolution can reach. It
 * is the ONLY signal a resident daemon or chat session gets that its cached
 * provider listing is stale, so a mutation that skips it leaves that session
 * refusing a model the user just connected until it restarts.
 *
 * Returns the new value so a caller can log or assert on it.
 */
export function bumpProviderRevision(): number {
  let next = 0;
  updateConfigFile((config) => {
    next = (config.providerRevision ?? 0) + 1;
    config.providerRevision = next;
  });
  return next;
}

export function resolveCloudOrigin(opts?: { origin?: string }): string {
  return (opts?.origin ?? process.env.KINU_ORIGIN ?? loadConfigFile().origin ?? DEFAULT_ORIGIN).replace(/\/+$/, '');
}

export function requireAuthConfig(): CloudAuthConfig {
  // CI path: a token from the environment (typically a scoped `pta_…` access
  // token from `kinu tokens create`) wins over the stored interactive
  // session. Long-lived by design — the server is the validity authority.
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

/** True when the stored interactive session's expiry has passed. Shared by
 *  auth gating and profile authority resolution. */
export function sessionExpired(config: KinuConfig): boolean {
  if (!config.tokenExpiresAt) return false;
  const expiresAt = Date.parse(config.tokenExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

/** The signed-in session as a model source, or null when signed out / expired.
 *  `KINU_TOKEN` wins here exactly as it does in requireAuthConfig. Asks rather
 *  than catching: an unreadable config is not a signed-out user. */
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

export function upsertAgentConfig(agent: Omit<KinuAgentConfig, 'createdAt' | 'updatedAt'> & Partial<Pick<KinuAgentConfig, 'createdAt' | 'updatedAt'>>): KinuAgentConfig {
  validateAgentName(agent.name);
  if (agent.alias) validateAliasName(agent.alias);
  if (agent.localName) validateAgentName(agent.localName);
  if (agent.cloudName) validateAgentName(agent.cloudName);
  if (agent.workspaceId) validateWorkspaceId(agent.workspaceId);
  const now = new Date().toISOString();
  let saved!: KinuAgentConfig;
  updateConfigFile((config) => {
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

export function removeCloudAgentConfig(cloudName: string): boolean {
  let removed = false;
  updateConfigFile((config) => {
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

export function setAliasConfig(agentName: string, alias: string): void {
  validateAgentName(agentName);
  validateAliasName(alias);
  updateConfigFile((config) => {
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

export function removeAliasConfig(alias: string): void {
  updateConfigFile((config) => {
    const agentName = config.aliases?.[alias];
    if (config.aliases) delete config.aliases[alias];
    if (agentName && config.agents?.[agentName]?.alias === alias) {
      config.agents[agentName] = { ...config.agents[agentName], alias: undefined, updatedAt: new Date().toISOString() };
    }
  });
}

export function aliasPath(alias: string): string {
  validateAliasName(alias);
  return join(BIN_DIR, alias);
}

export function writeAliasShim(agentName: string, alias: string): string {
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
  setAliasConfig(agentName, alias);
  return path;
}

export function deleteAliasShim(alias: string): void {
  validateAliasName(alias);
  tolerate(() => unlinkSync(aliasPath(alias)), 'enoent');
  removeAliasConfig(alias);
}

export function pathHint(): string | null {
  return (process.env.PATH ?? '').split(':').includes(BIN_DIR) ? null : `Add ${BIN_DIR} to PATH for kinu aliases.`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function validateAgentName(name: string): void {
  if (!AGENT_NAME_RE.test(name)) {
    throw new Error('Agent name must be 1-64 characters: letters, numbers, dashes, or underscores; it must start with a letter or number.');
  }
}

/** A virtual workspace label. Same shape as an agent name because a user
 *  types both on the command line. */
export function validateWorkspaceId(workspaceId: string): void {
  if (!AGENT_NAME_RE.test(workspaceId)) {
    throw new Error('Workspace id must be 1-64 characters: letters, numbers, dashes, or underscores; it must start with a letter or number.');
  }
}

export function validateAliasName(alias: string): void {
  if (!ALIAS_RE.test(alias)) {
    throw new Error('Alias must be 1-64 characters: letters, numbers, dashes, or underscores; it must start with a letter or number.');
  }
  if (RESERVED_ALIASES.has(alias)) {
    throw new Error(`Alias "${alias}" is reserved. Choose another alias.`);
  }
}

/**
 * The default inference endpoint for BARE model ids — the one input the
 * cli-backend registry cannot derive on its own. Total: null when nothing
 * derives one, because an explicit `provider/model` spec needs no endpoint at
 * all (registry-only families — the claude subscription, the opencode bridge —
 * carry their own auth seams). Seams that must hand core an endpoint object
 * use {@link requireLLMConfig}.
 */
export function resolveLLMConfig(opts?: {
  model?: string;
  baseUrl?: string;
  auth?: string;
}): LLMProviderConfig | null {
  const file = loadConfigFile();

  // Direct-endpoint overrides come only from explicit flags or env; provider
  // credentials in config.json are the persistent source of truth.
  const baseURL = opts?.baseUrl
    ?? process.env.KINU_BASE_URL
    ?? process.env.AI_GATEWAY_BASE_URL;

  const auth = opts?.auth
    ?? process.env.KINU_AUTH
    ?? process.env.AI_GATEWAY_AUTH;

  const model = opts?.model
    ?? process.env.KINU_MODEL
    ?? process.env.AI_GATEWAY_MODEL
    ?? file.model;

  if (baseURL && auth) {
    return {
      name: model?.startsWith('@cf/') ? 'workers-ai' : 'openai-compat',
      baseURL,
      headers: { 'Authorization': auth },
      model: directEndpointModelId(model ?? DEFAULT_WORKERS_AI_MODEL_ID),
    };
  }

  const cloud = resolveCloudSession();
  // The signed-in account IS the default inference path, and it owns the native
  // model families. Both halves matter: no selection lands on the platform
  // default rather than on whichever BYO key happens to sit on disk, and a
  // `workers-ai` / `my-gateway` / `@cf/` selection is answered by the account
  // rather than by a local endpoint that would happily accept the model id and
  // serve something else. Stored BYO credentials still win when the user picks
  // one of their models explicitly.
  const cloudConfig: LLMProviderConfig | null = cloud
    ? {
        name: 'workers-ai',
        baseURL: cloudProxyBaseURL(cloud.origin),
        headers: { Authorization: `Bearer ${cloud.token}` },
        model: workersAIModelId(model),
      }
    : null;
  if (cloudConfig && (!model || isNativeCloudSpec(model))) return cloudConfig;

  // An explicit spec naming a registry-only family resolves to that family —
  // ahead of any credential default, which exists to answer BARE ids.
  const family = registryFamilyMarker(model);
  if (family) return family;

  const derived = deriveLLMConfigFromProviderCredentials(file, model);
  if (derived) return derived;

  if (cloudConfig) return cloudConfig;

  // Half an advanced override is a misconfiguration, not an absence: name it.
  if (baseURL && !auth) {
    throw new Error(
      'No LLM auth configured.\n' +
      '  Run kinu setup and configure a local provider, or pass --auth for an advanced override.'
    );
  }

  return null;
}

/**
 * resolveLLMConfig for the seams that must hand core's runtime an endpoint
 * object (workspace creation, evolution). Resolution itself never requires
 * one — registry-only families run without it — so the failure names every
 * fix rather than leaking null downward.
 */
export function requireLLMConfig(opts?: {
  model?: string;
  baseUrl?: string;
  auth?: string;
}): LLMProviderConfig {
  const config = resolveLLMConfig(opts);
  if (config) return config;
  throw new Error(
    'No LLM configured.\n' +
    '  Run kinu auth to use your Cloudflare AI,\n' +
    '  run kinu setup to configure a local provider,\n' +
    '  sign in to Claude Code and pass --model claude/<model>,\n' +
    '  or pass --base-url for an advanced override.'
  );
}

/** Local provider credentials used by the CLI backend's provider registry.
 *  Env wins over ~/.kinu/config.json so temporary shell overrides work. */
export function resolveProviderCredentials(): LocalProviderCredentials {
  const file = loadConfigFile();
  return {
    openaiApiKey: process.env.OPENAI_API_KEY ?? file.providers?.openai?.apiKey,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? file.providers?.anthropic?.apiKey,
    openrouterApiKey: process.env.OPENROUTER_API_KEY ?? file.providers?.openrouter?.apiKey,
    codexAccessToken: process.env.CODEX_ACCESS_TOKEN,
    openaiCompat: file.providers?.openaiCompat,
  };
}

export function createCodexAuthStore(fetchFn?: typeof fetch): LocalCodexAuthStore {
  return createFileCodexAuthStore(CONFIG_PATH, { fetch: fetchFn });
}

/** Stdio MCP servers from ~/.kinu/config.json (`mcpServers`). Empty if none. */
export function resolveMcpServers(): Record<string, McpServerConfig> {
  return loadConfigFile().mcpServers ?? {};
}

function deriveLLMConfigFromProviderCredentials(file: KinuConfig, model: string | undefined): LLMProviderConfig | null {
  const providerModel = model ?? preferredModelFromCredentials(file);
  const hasCodexCredential = Boolean(process.env.CODEX_ACCESS_TOKEN || file.providers?.codex?.accessToken || file.providers?.codex?.refreshToken);
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
  // The local endpoint answers for any model id it might serve, but never for a
  // native Cloudflare spec: an Ollama on this machine will accept
  // `@cf/deepseek-ai/…` as a model name and serve something else entirely.
  if (compat && !(providerModel && isNativeCloudSpec(providerModel))) {
    const headers = { ...compat.headers };
    if (compat.apiKey) headers.Authorization = `Bearer ${compat.apiKey}`;
    Object.assign(headers, compat.extraHeaders);
    return {
      name: 'openai-compat',
      baseURL: compat.baseURL,
      headers,
      model: stripProvider(providerModel ?? 'gpt-4o-mini', 'openai-compat'),
    };
  }

  return null;
}

/** Registry-only families: served by the CLI backend's own providers from
 *  their own auth seams (the claude binary's subscription login, opencode's
 *  auth.json), so their endpoint config is a marker the resolver maps back to
 *  the family rather than a place to send HTTP. */
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
  if (file.model) return file.model;
  if (file.providers?.codex?.accessToken || file.providers?.codex?.refreshToken || process.env.CODEX_ACCESS_TOKEN) return `codex/${CODEX_DEFAULT_MODEL}`;
  if (file.providers?.openai?.apiKey || process.env.OPENAI_API_KEY) return `openai/${OPENAI_DEFAULT_MODEL}`;
  if (file.providers?.openrouter?.apiKey || process.env.OPENROUTER_API_KEY) return 'openrouter/openai/gpt-4o-mini';
  if (file.providers?.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY) return `anthropic/${ANTHROPIC_DEFAULT_MODEL}`;
  return undefined;
}

function stripProvider(model: string, provider: string): string {
  return model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
}

/** The Workers AI wire id for the proxy-derived config — a configured
 *  workers-ai model is honored; anything else falls to the platform default
 *  (non-workers-ai specs still resolve per-spec through the registry). */
function workersAIModelId(model: string | undefined): string {
  const stripped = stripProvider(model ?? '', WORKERS_AI_PROVIDER_ID);
  if (stripped !== (model ?? '')) return stripped || DEFAULT_WORKERS_AI_MODEL_ID;
  return model?.startsWith(WORKERS_AI_MODEL_ID_PREFIX) ? model : DEFAULT_WORKERS_AI_MODEL_ID;
}

/** Specs the signed-in account serves: the proxy's own provider ids plus the
 *  bare Workers AI wire form. */
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
