/**
 * CLI configuration — resolves LLM config from:
 *   1. CLI flags (highest priority)
 *   2. Environment variables (PROTEUS_BASE_URL, PROTEUS_AUTH, PROTEUS_MODEL)
 *   3. Legacy env vars (AI_GATEWAY_BASE_URL, AI_GATEWAY_AUTH, AI_GATEWAY_MODEL)
 *   4. Config file (~/.proteus/config.json)
 *   5. Defaults
 */

import { existsSync, readFileSync, mkdirSync, readdirSync, statSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { LLMProviderConfig } from '@proteus/core';
import type { LocalProviderCredentials, McpServerConfig } from '@proteus/cli-backend';

export const AGENT_HOME = join(homedir(), '.proteus');
export const CONFIG_PATH = join(AGENT_HOME, 'config.json');
export const BIN_DIR = join(AGENT_HOME, 'bin');
const DEFAULT_MODEL = '@cf/moonshotai/kimi-k2.6';
const DEFAULT_ORIGIN = 'https://proteus.ashishkmr472.workers.dev';

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
    codex?: { accessToken?: string };
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
}

export function ensureBinDir(): void {
  ensureAgentHome();
  mkdirSync(BIN_DIR, { recursive: true });
}

export function agentDbPath(name: string): string {
  return join(AGENT_HOME, name, 'agent.db');
}

export function agentDir(name: string): string {
  return join(AGENT_HOME, name);
}

export function listAgentDirs(): string[] {
  if (!existsSync(AGENT_HOME)) return [];
  return readdirSync(AGENT_HOME).filter(name => {
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
  const token = process.env.PROTEUS_TOKEN ?? config.accessToken;
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

export function upsertAgentConfig(agent: Omit<ProteusAgentConfig, 'createdAt' | 'updatedAt'> & Partial<Pick<ProteusAgentConfig, 'createdAt' | 'updatedAt'>>): ProteusAgentConfig {
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
  return join(BIN_DIR, alias);
}

export function writeAliasShim(agentName: string, alias: string): string {
  ensureBinDir();
  const path = aliasPath(alias);
  const script = `#!/usr/bin/env sh
exec proteus run ${shellQuote(agentName)} "$@"
`;
  writeFileSync(path, script, { mode: 0o755 });
  chmodSync(path, 0o755);
  setAliasConfig(agentName, alias);
  return path;
}

export function deleteAliasShim(alias: string): void {
  try { unlinkSync(aliasPath(alias)); } catch { /* already gone */ }
  removeAliasConfig(alias);
}

export function pathHint(): string | null {
  return (process.env.PATH ?? '').split(':').includes(BIN_DIR) ? null : `Add ${BIN_DIR} to PATH for proteus aliases.`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
    ?? file.model
    ?? DEFAULT_MODEL;

  if (!baseURL) {
    throw new Error(
      'No LLM base URL configured.\n' +
      '  Set PROTEUS_BASE_URL env var, pass --base-url, or add to ~/.proteus/config.json'
    );
  }
  if (!auth) {
    throw new Error(
      'No LLM auth configured.\n' +
      '  Set PROTEUS_AUTH env var, pass --auth, or add to ~/.proteus/config.json'
    );
  }

  return {
    name: 'workers-ai',
    baseURL,
    headers: { 'Authorization': auth },
    model,
  };
}

/** Local provider credentials used by the CLI backend's provider registry.
 *  Env wins over ~/.proteus/config.json so temporary shell overrides work. */
export function resolveProviderCredentials(): LocalProviderCredentials {
  const file = loadConfigFile();
  return {
    openaiApiKey: process.env.OPENAI_API_KEY ?? file.providers?.openai?.apiKey,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? file.providers?.anthropic?.apiKey,
    openrouterApiKey: process.env.OPENROUTER_API_KEY ?? file.providers?.openrouter?.apiKey,
    codexAccessToken: process.env.CODEX_ACCESS_TOKEN ?? file.providers?.codex?.accessToken,
    openaiCompat: file.providers?.openaiCompat,
  };
}

/** Stdio MCP servers from ~/.proteus/config.json (`mcpServers`). Empty if none. */
export function resolveMcpServers(): Record<string, McpServerConfig> {
  return loadConfigFile().mcpServers ?? {};
}
