import { existsSync, mkdirSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { generateText } from 'ai';
import {
  WORKSPACE_IDENTITY_SYSTEM_PROMPT,
  workspaceIdentityPrompt,
  createWorkspace,
  createAgentConfigStore,
  createWorkspaceNameFromMission as coreCreateAgentNameFromMission,
  fallbackWorkspaceIdentity,
  initAgentConfigTable,
  initCraftScoreTables,
  initScaffoldTables,
  initSearchTables,
  parseWorkspaceIdentityOutput,
  type LLMProviderConfig,
  type SuggestedWorkspaceIdentity,
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
import { createConfiguredLocalModelResolver } from './local-model-resolver.js';

export interface CreateCliAgentInput {
  /** Required for local agents. Omit for cloud agents to let the server
   *  generate the name (cloud naming is server-side). */
  name?: string;
  displayName?: string;
  nameOrigin?: 'user' | 'auto';
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
  displayName?: string;
  mode: AgentMode;
  purpose: string;
  model?: string;
  cloudName?: string;
  dbPath?: string;
  aliasPath?: string;
}

export interface SuggestAgentIdentityOptions {
  id?: string;
  model?: string;
  baseUrl?: string;
  auth?: string;
  generate?: (mission: string) => Promise<string>;
}

export function createWorkspaceNameFromMission(mission: string, id: string = crypto.randomUUID()): string {
  return coreCreateAgentNameFromMission(mission, id);
}

export async function suggestAgentIdentityFromMission(
  mission: string,
  opts: SuggestAgentIdentityOptions = {},
): Promise<SuggestedWorkspaceIdentity> {
  const id = opts.id ?? crypto.randomUUID();
  const fallback = fallbackWorkspaceIdentity(mission, id);
  try {
    const raw = opts.generate
      ? await opts.generate(mission)
      : await generateIdentityJson(mission, opts);
    const identity = parseWorkspaceIdentityOutput(raw, id);
    return identity || fallback;
  } catch {
    return fallback;
  }
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
    const userNamed = Boolean(input.name) && input.nameOrigin !== 'auto';
    const agent = await createCloudAgent(auth.origin, auth.token, {
      name: userNamed ? input.name : undefined,
      displayName: userNamed ? input.displayName ?? input.name : undefined,
      purpose,
    });
    upsertAgentConfig({
      name: agent.name,
      mode: 'cloud',
      displayName: agent.displayName,
      cloudName: agent.name,
      alias: input.alias || undefined,
    });
    const aliasPath = input.alias ? writeAliasShim(agent.name, input.alias) : undefined;
    return { name: agent.name, displayName: agent.displayName, mode: 'cloud', purpose, cloudName: agent.name, aliasPath };
  }

  const name = input.name;
  if (!name) throw new Error('Agent name required for local agents.');
  const displayName = input.displayName ?? name;
  const dir = agentDir(name);
  const dbPath = agentDbPath(name);
  if (existsSync(dbPath)) throw new Error(`Agent "${name}" already exists.`);

  const llmConfig = resolveLLMConfig(input);
  mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    const rt = createWorkspace(db, { name: displayName, purpose, llm: llmConfig });
    initSearchTables((ddl: string) => db.exec(ddl));
    initScaffoldTables((ddl: string) => db.exec(ddl));
    initCraftScoreTables((ddl: string) => db.exec(ddl));
    initAgentConfigTable(rt.storage.execRaw);
    const agentConfig = createAgentConfigStore(rt.storage.sql);
    agentConfig.setModel(modelSpecForAgentConfig(llmConfig, input.model));
    agentConfig.setDisplayName(displayName);
    agentConfig.setNameOrigin(input.nameOrigin ?? 'user');
  } finally {
    db.close();
  }

  upsertAgentConfig({
    name,
    mode: 'local',
    displayName,
    localName: name,
    alias: input.alias || undefined,
  });
  const aliasPath = input.alias ? writeAliasShim(name, input.alias) : undefined;
  ensureLocalDaemonRunning();
  return { name, displayName, mode: 'local', purpose, model: llmConfig.model, dbPath, aliasPath };
}

async function generateIdentityJson(mission: string, opts: SuggestAgentIdentityOptions): Promise<string> {
  const { resolver } = createConfiguredLocalModelResolver(opts);
  const result = await generateText({
    model: resolver.resolveModel(opts.model ?? null),
    system: WORKSPACE_IDENTITY_SYSTEM_PROMPT,
    prompt: workspaceIdentityPrompt(mission),
    maxOutputTokens: 80,
  });
  return result.text;
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
  if (llm.name === 'workers-ai') return `workers-ai/${llm.model}`;
  if (llm.name === 'codex') return llm.model.startsWith('codex/') ? llm.model : `codex/${llm.model}`;
  if (llm.name === 'openai') return `openai/${llm.model}`;
  if (llm.name === 'openrouter') return `openrouter/${llm.model}`;
  if (llm.name === 'anthropic') return `anthropic/${llm.model}`;
  return `openai-compat/${llm.model}`;
}
