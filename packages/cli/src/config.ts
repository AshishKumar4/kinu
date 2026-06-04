/**
 * CLI configuration — resolves LLM config from:
 *   1. CLI flags (highest priority)
 *   2. Environment variables (PROTEUS_BASE_URL, PROTEUS_AUTH, PROTEUS_MODEL)
 *   3. Legacy env vars (AI_GATEWAY_BASE_URL, AI_GATEWAY_AUTH, AI_GATEWAY_MODEL)
 *   4. Config file (~/.proteus/config.json)
 *   5. Defaults
 */

import { existsSync, readFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { LLMProviderConfig } from '@proteus/core';
import type { McpServerConfig } from '@proteus/cli-backend';

export const AGENT_HOME = join(homedir(), '.proteus');
const CONFIG_PATH = join(AGENT_HOME, 'config.json');
const DEFAULT_MODEL = '@cf/moonshotai/kimi-k2.6';

interface ProteusConfig {
  baseUrl?: string;
  auth?: string;
  model?: string;
  /** Stdio MCP servers to connect locally (standard mcpServers shape). */
  mcpServers?: Record<string, McpServerConfig>;
}

export function ensureAgentHome(): void {
  mkdirSync(AGENT_HOME, { recursive: true });
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

function loadConfigFile(): ProteusConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as ProteusConfig;
  } catch {
    return {};
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

/** Stdio MCP servers from ~/.proteus/config.json (`mcpServers`). Empty if none. */
export function resolveMcpServers(): Record<string, McpServerConfig> {
  return loadConfigFile().mcpServers ?? {};
}
