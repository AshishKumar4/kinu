/**
 * CLI configuration. App auth is stored in ~/.proteus/config.json after
 * `proteus setup`; direct LLM env vars remain as explicit local overrides.
 */

import { existsSync, readFileSync, mkdirSync, readdirSync, statSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  CODEX_BASE_URL,
  type LLMProviderConfig,
  type OAuthCredential,
} from '@proteus/core';
import {
  createFileCodexAuthStore,
  type LocalCodexAuthStore,
  type LocalProviderCredentials,
  type McpServerConfig,
} from '@proteus/cli-backend';

export const AGENT_HOME = resolve(process.env.PROTEUS_HOME?.trim() || join(homedir(), '.proteus'));
export const CONFIG_PATH = join(AGENT_HOME, 'config.json');
export const BIN_DIR = join(AGENT_HOME, 'bin');
const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_ALIASES = new Set([
  'proteus',
  'create',
  'auth',
  'whoami',
  'logout',
  'setup',
  'provider',
  'providers',
  'run',
  'chat',
  'evolve',
  'status',
  'list',
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
const DEFAULT_MODEL = '@cf/moonshotai/kimi-k2.6';
const DEFAULT_ORIGIN = 'https://proteus.ashishkumarsingh.com';
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

export type AgentMode = 'local' | 'cloud';

export interface ProteusAgentConfig {
  name: string;
  mode: AgentMode;
  alias?: string;
  localName?: string;
  cloudName?: string;
  purpose?: string;
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
  baseUrl?: string;
  auth?: string;
  model?: string;
  providers?: {
    openai?: { apiKey?: string };
    anthropic?: { apiKey?: string };
    openrouter?: { apiKey?: string };
    codex?: {
      accessToken?: string;
      refreshToken?: string;
      expiresAt?: number;
      metadata?: Record<string, unknown>;
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
}

export function ensureAgentHome(): void {
  mkdirSync(AGENT_HOME, { recursive: true });
  try { chmodSync(AGENT_HOME, 0o700); } catch { /* nop on filesystems without chmod */ }
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
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as ProteusConfig;
  } catch {
    return {};
  }
}

export function saveConfigFile(config: ProteusConfig): void {
  ensureAgentHome();
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(CONFIG_PATH, 0o600); } catch { /* nop on filesystems without chmod */ }
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

export function requireAuthConfig(): { origin: string; token: string; user?: ProteusConfig['user'] } {
  const config = loadConfigFile();
  const origin = resolveCloudOrigin();
  const token = config.accessToken;
  if (!token) {
    throw new Error('Not authenticated. Run: proteus auth');
  }
  return { origin, token, user: config.user };
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
    config.agents = { ...(config.agents ?? {}), [agent.name]: saved };
  });
  return saved;
}

export function setAliasConfig(agentName: string, alias: string): void {
  validateAgentName(agentName);
  validateAliasName(alias);
  updateConfigFile((config) => {
    config.aliases = { ...(config.aliases ?? {}), [alias]: agentName };
    const existing = config.agents?.[agentName];
    if (existing) {
      config.agents = {
        ...(config.agents ?? {}),
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
exec "$bin_dir/proteus" run ${shellQuote(agentName)} "$@"
`;
  writeFileSync(path, script, { mode: 0o755 });
  chmodSync(path, 0o755);
  setAliasConfig(agentName, alias);
  return path;
}

export function deleteAliasShim(alias: string): void {
  validateAliasName(alias);
  try { unlinkSync(aliasPath(alias)); } catch { /* already gone */ }
  removeAliasConfig(alias);
}

export function pathHint(): string | null {
  return (process.env.PATH ?? '').split(':').includes(BIN_DIR) ? null : `Add ${BIN_DIR} to PATH for proteus aliases.`;
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

  const baseURL = opts?.baseUrl
    ?? process.env.PROTEUS_BASE_URL
    ?? process.env.AI_GATEWAY_BASE_URL
    ?? file.baseUrl;

  const auth = opts?.auth
    ?? process.env.PROTEUS_AUTH
    ?? process.env.AI_GATEWAY_AUTH
    ?? file.auth;

  const model = opts?.model
    ?? process.env.PROTEUS_MODEL
    ?? process.env.AI_GATEWAY_MODEL
    ?? file.model;

  if (baseURL && auth) {
    return {
      name: model?.startsWith('@cf/') ? 'workers-ai' : 'openai-compat',
      baseURL,
      headers: { 'Authorization': auth },
      model: directEndpointModelId(model ?? DEFAULT_MODEL),
    };
  }

  const derived = deriveLLMConfigFromProviderCredentials(file, model);
  if (derived) return derived;

  if (!baseURL) {
    throw new Error(
      'No LLM base URL configured.\n' +
      '  Run proteus setup and configure a local provider, or pass --base-url for an advanced override.'
    );
  }
  if (!auth) {
    throw new Error(
      'No LLM auth configured.\n' +
      '  Run proteus setup and configure a local provider, or pass --auth for an advanced override.'
    );
  }

  return { name: 'openai-compat', baseURL, headers: { 'Authorization': auth }, model: directEndpointModelId(model ?? DEFAULT_MODEL) };
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

export function saveCodexOAuthCredential(credential: OAuthCredential): void {
  createCodexAuthStore().save(credential);
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
      model: stripProvider(providerModel ?? 'gpt-5.5', 'codex'),
    };
  }

  const openaiKey = process.env.OPENAI_API_KEY ?? file.providers?.openai?.apiKey;
  if (openaiKey && (!providerModel || providerModel.startsWith('openai/') || !providerModel.includes('/'))) {
    return {
      name: 'openai',
      baseURL: OPENAI_BASE_URL,
      headers: { Authorization: `Bearer ${openaiKey}` },
      model: stripProvider(providerModel ?? 'gpt-4o-mini', 'openai'),
    };
  }

  const openrouterKey = process.env.OPENROUTER_API_KEY ?? file.providers?.openrouter?.apiKey;
  if (openrouterKey && providerModel?.startsWith('openrouter/')) {
    return {
      name: 'openrouter',
      baseURL: OPENROUTER_BASE_URL,
      headers: {
        Authorization: `Bearer ${openrouterKey}`,
        'HTTP-Referer': DEFAULT_ORIGIN,
        'X-Title': 'Proteus CLI',
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
  if (compat) {
    return {
      name: 'openai-compat',
      baseURL: compat.baseURL,
      headers: {
        ...(compat.headers ?? {}),
        ...(compat.apiKey ? { Authorization: `Bearer ${compat.apiKey}` } : {}),
        ...(compat.extraHeaders ?? {}),
      },
      model: stripProvider(providerModel ?? 'gpt-4o-mini', 'openai-compat'),
    };
  }

  return null;
}

function preferredModelFromCredentials(file: ProteusConfig): string | undefined {
  if (file.model) return file.model;
  if (file.providers?.codex?.accessToken || file.providers?.codex?.refreshToken || process.env.CODEX_ACCESS_TOKEN) return 'codex/gpt-5.5';
  if (file.providers?.openai?.apiKey || process.env.OPENAI_API_KEY) return 'openai/gpt-4o-mini';
  if (file.providers?.openrouter?.apiKey || process.env.OPENROUTER_API_KEY) return 'openrouter/openai/gpt-4o-mini';
  if (file.providers?.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY) return 'anthropic/claude-sonnet-4-5';
  return undefined;
}

function stripProvider(model: string, provider: string): string {
  return model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
}

function directEndpointModelId(model: string): string {
  if (model.startsWith('workers-ai/')) return model.slice('workers-ai/'.length);
  if (model.startsWith('openai/')) return model.slice('openai/'.length);
  if (model.startsWith('openrouter/')) return model.slice('openrouter/'.length);
  if (model.startsWith('openai-compat/')) return model.slice('openai-compat/'.length);
  return model;
}
