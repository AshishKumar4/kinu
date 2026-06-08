import { existsSync, mkdirSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { generateText } from 'ai';
import {
  createAgent,
  createAgentConfigStore,
  deriveAgentTitle,
  extractJsonObject,
  initAgentConfigTable,
  initCraftScoreTables,
  initScaffoldTables,
  initSearchTables,
  jsonObjectOnlyInstruction,
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
import { createConfiguredLocalModelResolver } from './local-model-resolver.js';

export interface CreateCliAgentInput {
  name: string;
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

export interface SuggestedAgentIdentity {
  name: string;
  displayName: string;
  nameOrigin: 'auto' | 'user';
}

export interface SuggestAgentIdentityOptions {
  id?: string;
  model?: string;
  baseUrl?: string;
  auth?: string;
  generate?: (mission: string) => Promise<string>;
}

export function createAgentNameFromMission(mission: string, id: string = crypto.randomUUID()): string {
  const slug = slugifyName(mission) || 'agent';
  return `${slug}-${id.slice(0, 6)}`;
}

export async function suggestAgentIdentityFromMission(
  mission: string,
  opts: SuggestAgentIdentityOptions = {},
): Promise<SuggestedAgentIdentity> {
  const id = opts.id ?? crypto.randomUUID();
  const fallback = fallbackIdentity(mission, id);
  try {
    const raw = opts.generate
      ? await opts.generate(mission)
      : await generateIdentityJson(mission, opts);
    const parsed = extractJsonObject(raw);
    if (!isRecord(parsed)) return fallback;
    const title = cleanTitle(typeof parsed.title === 'string' ? parsed.title : '');
    const slugSource = typeof parsed.slug === 'string' ? parsed.slug : title;
    const slug = slugifyName(slugSource) || slugifyName(title);
    if (!title || !slug) return fallback;
    return {
      name: `${slug}-${id.slice(0, 6)}`,
      displayName: title,
      nameOrigin: 'auto',
    };
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
    const displayName = input.displayName ?? input.name;
    const agent = await createCloudAgent(auth.origin, auth.token, {
      name: input.name,
      displayName,
      purpose,
    });
    upsertAgentConfig({
      name: input.name,
      mode: 'cloud',
      displayName,
      cloudName: agent.name,
      alias: input.alias || undefined,
    });
    const aliasPath = input.alias ? writeAliasShim(input.name, input.alias) : undefined;
    return { name: input.name, displayName, mode: 'cloud', purpose, cloudName: agent.name, aliasPath };
  }

  const displayName = input.displayName ?? input.name;
  const dir = agentDir(input.name);
  const dbPath = agentDbPath(input.name);
  if (existsSync(dbPath)) throw new Error(`Agent "${input.name}" already exists.`);

  const llmConfig = resolveLLMConfig(input);
  mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    const rt = createAgent(db, { name: displayName, purpose, llm: llmConfig });
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
    name: input.name,
    mode: 'local',
    displayName,
    localName: input.name,
    alias: input.alias || undefined,
  });
  const aliasPath = input.alias ? writeAliasShim(input.name, input.alias) : undefined;
  ensureLocalDaemonRunning();
  return { name: input.name, displayName, mode: 'local', purpose, model: llmConfig.model, dbPath, aliasPath };
}

async function generateIdentityJson(mission: string, opts: SuggestAgentIdentityOptions): Promise<string> {
  const { resolver } = createConfiguredLocalModelResolver(opts);
  const result = await generateText({
    model: resolver.resolveModel(opts.model ?? null),
    system: 'You create short, useful names for persistent software agents.',
    prompt: [
      'Name a Proteus agent from this opening mission.',
      '',
      'Return a concise JSON object with:',
      '- title: 2-5 words, Title Case, specific to the mission, no quotes, no trailing punctuation.',
      '- slug: 2-5 lowercase words joined with hyphens, no generic words like agent or assistant unless essential.',
      '',
      jsonObjectOnlyInstruction(),
      '',
      `Mission:\n${mission.slice(0, 1200)}`,
    ].join('\n'),
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
  if (llm.name === 'workers-ai') return llm.model.startsWith('@cf/') ? `workers-ai/${llm.model}` : `workers-ai/${llm.model}`;
  if (llm.name === 'codex') return llm.model.startsWith('codex/') ? llm.model : `codex/${llm.model}`;
  if (llm.name === 'openai') return `openai/${llm.model}`;
  if (llm.name === 'openrouter') return `openrouter/${llm.model}`;
  if (llm.name === 'anthropic') return `anthropic/${llm.model}`;
  return `openai-compat/${llm.model}`;
}

function fallbackIdentity(mission: string, id: string): SuggestedAgentIdentity {
  return {
    name: createAgentNameFromMission(mission, id),
    displayName: deriveAgentTitle(mission) || 'Agent',
    nameOrigin: 'auto',
  };
}

function cleanTitle(value: string): string {
  return value
    .replace(/^["'#\s]+|["'\s.]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 60)
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
