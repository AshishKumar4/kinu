import { existsSync, mkdirSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { generateText } from 'ai';
import {
  WORKSPACE_TITLE_SYSTEM_PROMPT,
  workspaceTitlePrompt,
  changeActiveRole, createAgentConfigStore,
  fallbackWorkspaceIdentity,
  initWorkspaceSchema,
  parseWorkspaceTitle,
  type LLMProviderConfig,
  type ReasoningEffort,
  type SuggestedWorkspaceIdentity,
} from '@kinu.run/core';
import { loadActiveProfile } from './profiles';
import { createWorkspace } from '@kinu.run/core/identity';
import { diagnostics, renderThrownChain } from '@kinu.run/core/obs';
import { makeWorkspaceSchemaSql } from '@kinu.run/cli-backend';
import {
  agentDbPath,
  agentDir,
  canonicalProjectRoot,
  defaultVirtualWorkspaceId,
  ensureAgentHome,
  loadConfigFile,
  localWorkspaceMembers,
  requireAuthConfig,
  requireLLMConfig,
  resolveAgentRef,
  resolveLLMConfig,
  upsertAgentConfig,
  validateWorkspaceId,
  writeAliasShim,
  type AgentMode,
} from './config';
import {
  createCloudAgent,
  type CloudAgent,
  type CreateCloudAgentInput,
} from './cloud-api';
import { authCommand } from './commands/auth';
import { ensureLocalDaemonRunning } from './commands/daemon';
import { createConfiguredLocalModelResolver } from './local-model-resolver';

export interface CreateCliAgentInput {
  /** Required for local agents. Cloud agents are named from their mission
   *  when this is omitted. */
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
  reasoningEffort?: ReasoningEffort;
  role?: string;
  /** Physical project directory. Defaults to the invocation cwd. */
  cwd?: string;
  /** Virtual workspace to join, existing or new. Defaults to the project's own
   *  label, so two `kinu create` calls in one directory produce peers. */
  workspaceId?: string;
}

export interface CreatedCliAgent {
  name: string;
  displayName?: string;
  mode: AgentMode;
  purpose: string;
  model?: string;
  cloudName?: string;
  dbPath?: string;
  cwd?: string;
  workspaceId?: string;
  /** Agents already in that virtual workspace — empty when this call opened a
   *  new one, populated when it joined an existing one as a peer. */
  peers?: string[];
  aliasPath?: string;
}

export interface SuggestAgentIdentityOptions {
  id?: string;
  model?: string;
  baseUrl?: string;
  auth?: string;
  generate?: (mission: string) => Promise<string>;
}

/** The workspace's permanent slug plus the best title available for it: the
 *  generated one when the model answers, the mission-derived one otherwise.
 *  The slug never depends on either — it is the id's, and only the id's. */
export async function suggestAgentIdentityFromMission(
  mission: string,
  opts: SuggestAgentIdentityOptions = {},
): Promise<SuggestedWorkspaceIdentity> {
  const fallback = fallbackWorkspaceIdentity(mission, opts.id ?? crypto.randomUUID());
  try {
    const raw = opts.generate
      ? await opts.generate(mission)
      : await generateTitleJson(mission, opts);
    const title = parseWorkspaceTitle(raw);
    return title ? { ...fallback, displayName: title } : fallback;
  } catch (error) {
    diagnostics.event('agent.title_fallback', { error: renderThrownChain({ cause: error }) });
    return fallback;
  }
}

export interface CreateCloudAgentFromMissionOptions {
  id?: string;
  generate?: (mission: string) => Promise<string>;
  create: (input: CreateCloudAgentInput) => Promise<CloudAgent>;
}

export async function createCloudAgentFromMission(
  input: Pick<CreateCliAgentInput, 'name' | 'displayName' | 'nameOrigin' | 'purpose' | 'model' | 'baseUrl' | 'auth' | 'reasoningEffort' | 'role'>,
  options: CreateCloudAgentFromMissionOptions,
): Promise<CloudAgent> {
  const userNamed = Boolean(input.name) && input.nameOrigin !== 'auto';
  const identity = userNamed
    ? { name: input.name, displayName: input.displayName ?? input.name }
    : await suggestAgentIdentityFromMission(input.purpose, {
        id: options.id,
        model: input.model,
        baseUrl: input.baseUrl,
        auth: input.auth,
        generate: options.generate,
      });
  const createInput: CreateCloudAgentInput = {
    name: identity.name,
    displayName: identity.displayName,
    purpose: input.purpose,
  };
  if (input.model) createInput.model = input.model;
  if (input.reasoningEffort) createInput.reasoningEffort = input.reasoningEffort;
  if (input.role) createInput.role = input.role;
  return options.create(createInput);
}

export function isCloudAuthConfigured(): boolean {
  return Boolean(loadConfigFile().accessToken);
}

/** Whether ANY inference path exists: a derived endpoint, or any provider the
 *  registry could serve. A config.json that will not parse is a real failure
 *  and propagates — repainting it as "run setup" is how a broken install
 *  looks like a fresh one. */
export function isLocalModelConfigured(): boolean {
  try {
    return resolveLLMConfig({}) !== null;
  } catch (error) {
    // Only the half-set-override diagnostic reads as "not usable yet". Anything
    // else — a config.json that will not parse, a stored spec that will not
    // resolve — is a real failure and propagates.
    if (error instanceof Error && error.message.startsWith('No LLM auth configured')) return false;
    throw error;
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
    const defaults = loadConfigFile();
    const agent = await createCloudAgentFromMission({
      ...input,
      purpose,
      model: input.model ?? defaults.model,
      reasoningEffort: input.reasoningEffort ?? defaults.reasoningEffort,
    }, {
      create: (cloudInput) => createCloudAgent(auth.origin, auth.token, cloudInput),
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
  if (!name) throw new Error('Agent name required for a local workspace.');
  const displayName = input.displayName ?? name;
  const cwd = canonicalProjectRoot(input.cwd);
  const workspaceId = input.workspaceId ?? defaultVirtualWorkspaceId(cwd);
  validateWorkspaceId(workspaceId);
  const claimed = resolveAgentRef(name);
  if (claimed && claimed.mode !== 'local') {
    throw new Error(`"${name}" is already a cloud workspace. Choose another name.`);
  }
  const dbPath = agentDbPath(name);
  if (existsSync(dbPath)) throw new Error(nameTaken(name, dbPath, claimed));
  // Read before the workspace exists, so it reports who this agent JOINS.
  const peers = localWorkspaceMembers(workspaceId, cwd).map((peer) => peer.name);
  const llmConfig = requireLLMConfig(input);
  mkdirSync(agentDir(name), { recursive: true });
  const db = new Database(dbPath);
  let identityId: string | undefined;
  try {
    db.exec('PRAGMA journal_mode = WAL');
    const rt = await createWorkspace(db, { name: displayName, purpose, llm: llmConfig });
    identityId = rt.storage.sql<{ id: string }>`SELECT id FROM workspace_identity LIMIT 1`[0]?.id;
    // Every table a workspace has, on any backend — one list, in core.
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const agentConfig = createAgentConfigStore(rt.storage.sql);
    agentConfig.setModel(modelSpecForAgentConfig(llmConfig, input.model));
    const reasoningEffort = input.reasoningEffort ?? loadConfigFile().reasoningEffort;
    if (reasoningEffort) agentConfig.setReasoningEffort(reasoningEffort);
    agentConfig.setDisplayName(displayName);
    agentConfig.setNameOrigin(input.nameOrigin ?? 'user');
    if (input.role && input.role !== 'general') {
      const changed = changeActiveRole({
        config: agentConfig,
        envelope: await loadActiveProfile(),
        to: input.role,
        actor: 'user',
      });
      if (changed.kind !== 'applied') {
        throw new Error(`role "${input.role}" was refused: ${changed.kind === 'refused' ? changed.reason : changed.kind}`);
      }
    }
  } finally {
    db.close();
  }

  upsertAgentConfig({
    name,
    mode: 'local',
    displayName,
    localName: name,
    alias: input.alias || undefined,
    cwd,
    workspaceId,
    identityId,
  });
  const aliasPath = input.alias ? writeAliasShim(name, input.alias) : undefined;
  ensureLocalDaemonRunning();
  return {
    name, displayName, mode: 'local', purpose, model: llmConfig.model,
    dbPath, aliasPath, cwd, workspaceId, peers,
  };
}

/** An agent name is a directory under `~/.kinu`, so it is unique per machine.
 *  Say which project and workspace already hold it: creating the same name in a
 *  second project is exactly how a user reaches this. */
function nameTaken(name: string, dbPath: string, held: { cwd?: string; workspaceId?: string } | null): string {
  const placement = held?.cwd && held.workspaceId
    ? ` It belongs to workspace "${held.workspaceId}" in ${held.cwd}.`
    : '';
  return `Workspace "${name}" already exists at ${dbPath}.${placement} Choose another name.`;
}

async function generateTitleJson(mission: string, opts: SuggestAgentIdentityOptions): Promise<string> {
  const { resolver } = createConfiguredLocalModelResolver(opts);
  const result = await generateText({
    model: resolver.resolveModel(opts.model ?? null),
    system: WORKSPACE_TITLE_SYSTEM_PROMPT,
    prompt: workspaceTitlePrompt(mission),
    // No output cap: reasoning models spend budget on thinking before the
    // JSON, so a cap starves them into empty text (the fallback-name bug).
    // Cheapness comes from low reasoning effort, not output caps.
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
