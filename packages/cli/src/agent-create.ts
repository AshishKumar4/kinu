import { existsSync, mkdirSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import {
  createAgent,
  createAgentConfigStore,
  initAgentConfigTable,
  initCraftScoreTables,
  initScaffoldTables,
  initSearchTables,
  slugifyName,
  type LLMProviderConfig,
} from '@proteus/core';
import {
  agentDbPath,
  agentDir,
  ensureAgentHome,
  loadConfigFile,
  requireAuthConfig,
  resolveLLMConfig,
  upsertAgentConfig,
  writeAliasShim,
  type AgentMode,
} from './config.js';
import { createCloudAgent } from './cloud-api.js';
import { authCommand } from './commands/auth.js';
import { ensureLocalDaemonRunning } from './commands/daemon.js';

export interface CreateCliAgentInput {
  name: string;
  purpose: string;
  mode: AgentMode;
  alias?: string;
  model?: string;
  baseUrl?: string;
  auth?: string;
  origin?: string;
  allowInteractiveAuth?: boolean;
}

export interface CreatedCliAgent {
  name: string;
  mode: AgentMode;
  purpose: string;
  model?: string;
  cloudName?: string;
  dbPath?: string;
  aliasPath?: string;
}

export function createAgentNameFromMission(mission: string, id = crypto.randomUUID()): string {
  const slug = slugifyName(mission) || 'agent';
  return `${slug}-${id.slice(0, 6)}`;
}

export function isCloudAuthConfigured(): boolean {
  return Boolean(loadConfigFile().accessToken);
}

export function isLocalModelConfigured(): boolean {
  try {
    resolveLLMConfig({});
    return true;
  } catch {
    return false;
  }
}

export function defaultCreateMode(): AgentMode {
  return isCloudAuthConfigured() ? 'cloud' : 'local';
}

export async function createCliAgent(input: CreateCliAgentInput): Promise<CreatedCliAgent> {
  ensureAgentHome();
  const purpose = input.purpose.trim();
  if (!purpose) throw new Error('Mission required.');

  if (input.mode === 'cloud') {
    const auth = await resolveCloudAuth(input.origin, input.allowInteractiveAuth === true);
    const agent = await createCloudAgent(auth.origin, auth.token, {
      name: input.name,
      displayName: input.name,
      purpose,
    });
    upsertAgentConfig({
      name: input.name,
      mode: 'cloud',
      cloudName: agent.name,
      alias: input.alias || undefined,
    });
    const aliasPath = input.alias ? writeAliasShim(input.name, input.alias) : undefined;
    return { name: input.name, mode: 'cloud', purpose, cloudName: agent.name, aliasPath };
  }

  const dir = agentDir(input.name);
  const dbPath = agentDbPath(input.name);
  if (existsSync(dbPath)) throw new Error(`Agent "${input.name}" already exists.`);

  const llmConfig = resolveLLMConfig(input);
  mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    const rt = createAgent(db, { name: input.name, purpose, llm: llmConfig });
    initSearchTables((ddl: string) => db.exec(ddl));
    initScaffoldTables((ddl: string) => db.exec(ddl));
    initCraftScoreTables((ddl: string) => db.exec(ddl));
    initAgentConfigTable(rt.storage.execRaw);
    const agentConfig = createAgentConfigStore(rt.storage.sql);
    agentConfig.setModel(modelSpecForAgentConfig(llmConfig, input.model));
    agentConfig.setDisplayName(input.name);
    agentConfig.setNameOrigin('user');
  } finally {
    db.close();
  }

  upsertAgentConfig({
    name: input.name,
    mode: 'local',
    localName: input.name,
    alias: input.alias || undefined,
  });
  const aliasPath = input.alias ? writeAliasShim(input.name, input.alias) : undefined;
  ensureLocalDaemonRunning();
  return { name: input.name, mode: 'local', purpose, model: llmConfig.model, dbPath, aliasPath };
}

async function resolveCloudAuth(origin: string | undefined, allowInteractiveAuth: boolean): Promise<{ origin: string; token: string }> {
  try {
    return requireAuthConfig();
  } catch (err) {
    if (!allowInteractiveAuth || !process.stdin.isTTY || !process.stdout.isTTY) throw err;
    await authCommand({ origin });
    return requireAuthConfig();
  }
}

function modelSpecForAgentConfig(llm: LLMProviderConfig, rawModel: string | undefined): string {
  const configured = rawModel ?? loadConfigFile().model;
  if (configured) return configured;
  if (llm.name === 'workers-ai') return llm.model.startsWith('@cf/') ? `workers-ai/${llm.model}` : `workers-ai/${llm.model}`;
  if (llm.name === 'codex') return llm.model.startsWith('codex/') ? llm.model : `codex/${llm.model}`;
  if (llm.name === 'openai') return `openai/${llm.model}`;
  if (llm.name === 'openrouter') return `openrouter/${llm.model}`;
  if (llm.name === 'anthropic') return `anthropic/${llm.model}`;
  return `openai-compat/${llm.model}`;
}
