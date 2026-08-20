/**
 * CLI configuration. App auth is stored in ~/.proteus/config.json after
 * `kinu setup`; direct LLM env vars remain as explicit local overrides.
 */

import { existsSync, readFileSync, mkdirSync, readdirSync, statSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  ANTHROPIC_BASE_URL,
  ANTHROPIC_DEFAULT_MODEL,
  CODEX_BASE_URL,
  CODEX_DEFAULT_MODEL,
  DEFAULT_WORKERS_AI_MODEL_ID,
  OPENAI_BASE_URL,
  OPENAI_DEFAULT_MODEL,
  OPENROUTER_BASE_URL,
  JsonObjectSchema,
  type LLMProviderConfig,
  type JsonObject,
  type ReasoningEffort,
} from '@kinu/core';
import { tolerate } from '@kinu/core/obs';
import {
  CLOUD_PROXY_PROVIDER_IDS,
  cloudProxyBaseURL,
  createFileCodexAuthStore,
  ensureSecretDir,
  proteusHome,
  writeSecretFile,
  type LocalCloudSession,
  type LocalCodexAuthStore,
  type LocalProviderCredentials,
  type McpServerConfig,
} from '@kinu/cli-backend';
import * as v from 'valibot';

export const AGENT_HOME = proteusHome();
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
  'sessions',
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

export interface ProteusAgentConfig {
  name: string;
  mode: AgentMode;
  displayName?: string;
  alias?: string;
  localName?: string;
  cloudName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProteusConfig {
  origin?: string;
  accessToken?: string;
  tokenExpiresAt?: string;
  user?: { id: string; email: string; displayName?: string | null };
  agents?: Record<string, ProteusAgentConfig>;
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
}

export interface CloudAuthConfig {
  origin: string;
  token: string;
  user?: ProteusConfig['user'];
}

const StringMapSchema = v.record(v.string(), v.string());
const ProteusAgentConfigSchema = v.object({
  name: v.string(),
  mode: v.picklist(['local', 'cloud']),
  displayName: v.optional(v.string()),
  alias: v.optional(v.string()),
  localName: v.optional(v.string()),
  cloudName: v.optional(v.string()),
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
const ProteusConfigSchema: v.GenericSchema<ProteusConfig> = v.object({
  origin: v.optional(v.string()),
  accessToken: v.optional(v.string()),
  tokenExpiresAt: v.optional(v.string()),
  user: v.optional(v.object({
    id: v.string(),
    email: v.string(),
    displayName: v.optional(v.nullable(v.string())),
  })),
  agents: v.optional(v.record(v.string(), ProteusAgentConfigSchema)),
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
});

export function ensureAgentHome(): void {
  ensureSecretDir(AGENT_HOME);
}

export function ensureBinDir(): void {
  ensureAgentHome();
  mkdirSync(BIN_DIR, { recursive: true });
}

export function agentDbPath(name: string): string {
  validateAgentName(name);
  return join(AGENT_HOME, name, 'agent.db');
}

export function agentDir(name: string): string {
  validateAgentName(name);
  return join(AGENT_HOME, name);
}

export function listAgentDirs(): string[] {
  if (!existsSync(AGENT_HOME)) return [];
  return readdirSync(AGENT_HOME).filter(name => {
    if (!AGENT_NAME_RE.test(name)) return false;
    const dir = join(AGENT_HOME, name);
    return statSync(dir).isDirectory() && existsSync(join(dir, 'agent.db'));
  });
}

export function loadConfigFile(): ProteusConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return v.parse(ProteusConfigSchema, JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')));
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

export function setDefaultReasoningEffort(effort: ReasoningEffort): ReasoningEffort {
  updateConfigFile((config) => { config.reasoningEffort = effort; });
  return effort;
}

export function saveConfigFile(config: ProteusConfig): void {
  ensureAgentHome();
  writeSecretFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

export function updateConfigFile(mutator: (config: ProteusConfig) => ProteusConfig | void): ProteusConfig {
  const config = loadConfigFile();
  const next = mutator(config) ?? config;
  saveConfigFile(next);
  return next;
}

export function resolveCloudOrigin(opts?: { origin?: string }): string {
  return (opts?.origin ?? process.env.PROTEUS_ORIGIN ?? loadConfigFile().origin ?? DEFAULT_ORIGIN).replace(/\/+$/, '');
}

export function requireAuthConfig(): CloudAuthConfig {
  // CI path: a token from the environment (typically a scoped `pta_…` access
  // token from `kinu tokens create`) wins over the stored interactive
  // session. Long-lived by design — the server is the validity authority.
  const envToken = process.env.PROTEUS_TOKEN?.trim();
  if (envToken) return { origin: resolveCloudOrigin(), token: envToken };
  return storedAuthConfig('Not authenticated. Run: kinu auth (or set PROTEUS_TOKEN)');
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

function sessionExpired(config: ProteusConfig): boolean {
  if (!config.tokenExpiresAt) return false;
  const expiresAt = Date.parse(config.tokenExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

/** The signed-in session as a model source, or null when signed out / expired.
 *  `PROTEUS_TOKEN` wins here exactly as it does in requireAuthConfig. Asks rather
 *  than catching: an unreadable config is not a signed-out user. */
export function resolveCloudSession(): LocalCloudSession | null {
  const envToken = process.env.PROTEUS_TOKEN?.trim();
  if (envToken) return { origin: resolveCloudOrigin(), token: envToken };
  const config = loadConfigFile();
  const token = config.accessToken;
  if (!token || sessionExpired(config)) return null;
  return { origin: resolveCloudOrigin(), token };
}

export function resolveAgentRef(input: string): ProteusAgentConfig | null {
  const config = loadConfigFile();
  const canonical = config.aliases?.[input] ?? input;
  return config.agents?.[canonical] ?? null;
}

export function listConfiguredAgentRefs(): ProteusAgentConfig[] {
  return Object.values(loadConfigFile().agents ?? {})
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function upsertAgentConfig(agent: Omit<ProteusAgentConfig, 'createdAt' | 'updatedAt'> & Partial<Pick<ProteusAgentConfig, 'createdAt' | 'updatedAt'>>): ProteusAgentConfig {
  validateAgentName(agent.name);
  if (agent.alias) validateAliasName(agent.alias);
  if (agent.localName) validateAgentName(agent.localName);
  if (agent.cloudName) validateAgentName(agent.cloudName);
  const now = new Date().toISOString();
  let saved!: ProteusAgentConfig;
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

export function validateAliasName(alias: string): void {
  if (!ALIAS_RE.test(alias)) {
    throw new Error('Alias must be 1-64 characters: letters, numbers, dashes, or underscores; it must start with a letter or number.');
  }
  if (RESERVED_ALIASES.has(alias)) {
    throw new Error(`Alias "${alias}" is reserved. Choose another alias.`);
  }
}

export function resolveLLMConfig(opts?: {
  model?: string;
  baseUrl?: string;
  auth?: string;
}): LLMProviderConfig {
  const file = loadConfigFile();

  // Direct-endpoint overrides come only from explicit flags or env; provider
  // credentials in config.json are the persistent source of truth.
  const baseURL = opts?.baseUrl
    ?? process.env.PROTEUS_BASE_URL
    ?? process.env.AI_GATEWAY_BASE_URL;

  const auth = opts?.auth
    ?? process.env.PROTEUS_AUTH
    ?? process.env.AI_GATEWAY_AUTH;

  const model = opts?.model
    ?? process.env.PROTEUS_MODEL
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

  const derived = deriveLLMConfigFromProviderCredentials(file, model);
  if (derived) return derived;

  if (cloudConfig) return cloudConfig;

  if (!baseURL) {
    throw new Error(
      'No LLM configured.\n' +
      '  Run kinu auth to use your Cloudflare AI, run kinu setup to configure a local provider,\n' +
      '  or pass --base-url for an advanced override.'
    );
  }
  if (!auth) {
    throw new Error(
      'No LLM auth configured.\n' +
      '  Run kinu setup and configure a local provider, or pass --auth for an advanced override.'
    );
  }

  return { name: 'openai-compat', baseURL, headers: { 'Authorization': auth }, model: directEndpointModelId(model ?? DEFAULT_WORKERS_AI_MODEL_ID) };
}

/** Local provider credentials used by the CLI backend's provider registry.
 *  Env wins over ~/.proteus/config.json so temporary shell overrides work. */
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

/** Stdio MCP servers from ~/.proteus/config.json (`mcpServers`). Empty if none. */
export function resolveMcpServers(): Record<string, McpServerConfig> {
  return loadConfigFile().mcpServers ?? {};
}

function deriveLLMConfigFromProviderCredentials(file: ProteusConfig, model: string | undefined): LLMProviderConfig | null {
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

  // OpenCode bridge — no credential stored in config; the provider reads
  // opencode's auth.json and remote config at request time. We just need to
  // return a config whose `name` maps to the opencode provider in the
  // registry so the model spec resolves correctly.
  if (providerModel?.startsWith('opencode/')) {
    return {
      name: 'opencode',
      baseURL: '',
      headers: {},
      model: stripProvider(providerModel, 'opencode'),
    };
  }

  return null;
}

function preferredModelFromCredentials(file: ProteusConfig): string | undefined {
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
  if (model?.startsWith('workers-ai/')) {
    return model.slice('workers-ai/'.length) || DEFAULT_WORKERS_AI_MODEL_ID;
  }
  return model?.startsWith('@cf/') ? model : DEFAULT_WORKERS_AI_MODEL_ID;
}

/** Specs the signed-in account serves: the proxy's own provider ids plus the
 *  bare Workers AI wire form. */
function isNativeCloudSpec(model: string): boolean {
  return model.startsWith('@cf/')
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
