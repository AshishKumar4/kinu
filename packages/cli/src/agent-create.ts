import { existsSync, mkdirSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { generateText } from 'ai';
import {
  WORKSPACE_TITLE_SYSTEM_PROMPT,
  workspaceTitlePrompt,
  changeActiveRole, createAgentConfigStore,
  DEFAULT_ROLE_ID,
  fallbackWorkspaceIdentity,
  initWorkspaceSchema,
  parseWorkspaceTitle,
  readMission,
  workspaceSlug,
  type LLMProviderConfig,
  type ReasoningEffort,
  type SuggestedWorkspaceIdentity,
} from '@kinu.run/core';
import { loadActiveProfile } from './profiles';
import { createWorkspace } from '@kinu.run/core/identity';
import { diagnostics, renderThrownChain } from '@kinu.run/core/obs';
import { defaultSpecForEndpoint, makeSql, makeWorkspaceSchemaSql } from '@kinu.run/cli-backend';
import {
  agentDbPath,
  agentDir,
  canonicalProjectRoot,
  defaultVirtualWorkspaceId,
  ensureAgentHome,
  loadConfigFile,
  localWorkspaceMembers,
  readWorkspaceIdentityId,
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
  try {
    db.exec('PRAGMA journal_mode = WAL');
    // A blank display name is the provisional state of an agent added without
    // one; the slug is what it is genuinely called until a title lands, so it
    // is what the workspace identity and SOUL open with.
    const rt = await createWorkspace(db, { name: displayName || name, purpose, llm: llmConfig });
    // Every table a workspace has, on any backend — one list, in core.
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const agentConfig = createAgentConfigStore(rt.storage.sql);
    agentConfig.setModel(modelSpecForAgentConfig(llmConfig, input.model));
    const reasoningEffort = input.reasoningEffort ?? loadConfigFile().reasoningEffort;
    if (reasoningEffort) agentConfig.setReasoningEffort(reasoningEffort);
    // Title and whose it is, in one write. The origin is what the title policy
    // reads to decide whether it may ever name this agent itself.
    agentConfig.setDisplayNameOrigin(displayName, input.nameOrigin ?? 'user');
    if (input.role && input.role !== DEFAULT_ROLE_ID) {
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
    localName: name,
    alias: input.alias || undefined,
    cwd,
    workspaceId,
    // The database's own durable id, read back through the one helper that
    // knows both the current table and the pre-rename one — so a ref records
    // the same identity whether creation wrote it or adoption found it.
    identityId: readWorkspaceIdentityId(dbPath) ?? undefined,
  });
  const aliasPath = input.alias ? writeAliasShim(name, input.alias) : undefined;
  ensureLocalDaemonRunning();
  return {
    name, displayName, mode: 'local', purpose, model: llmConfig.model,
    dbPath, aliasPath, cwd, workspaceId, peers,
  };
}

/**
 * Add an agent to the virtual workspace already in this directory, with
 * nothing said about it.
 *
 * The owner supplies no name, no mission and no role. It inherits the mission
 * of a peer already in the workspace — the same text the cloud path inherits
 * from its parent workspace — takes a stable slug of its own, and starts with
 * a BLANK title and `auto` origin so its first owner message names it
 * (`autoTitleLocalWorkspace`).
 *
 * Refuses when the workspace has no peer yet: there would be nothing to
 * inherit, and inventing a mission is not the same thing as inheriting one.
 * `kinu create` is the command that opens a workspace; this one joins it.
 */
export async function createLocalPeerAgent(
  input: { cwd?: string; workspaceId?: string; role?: string } = {},
): Promise<CreatedCliAgent> {
  ensureAgentHome();
  const cwd = canonicalProjectRoot(input.cwd);
  const workspaceId = input.workspaceId ?? defaultVirtualWorkspaceId(cwd);
  validateWorkspaceId(workspaceId);
  const peers = localWorkspaceMembers(workspaceId, cwd);
  const purpose = inheritedPeerMission(peers);
  if (!purpose) {
    throw new Error(
      `No agent in workspace "${workspaceId}" to inherit a mission from. `
      + 'Create the first one with: kinu create',
    );
  }
  const created: CreateCliAgentInput = {
    // Same permanent-address shape the cloud path mints: a neutral memorable
    // pair plus id digits, never mission text.
    name: workspaceSlug(crypto.randomUUID()),
    displayName: '',
    nameOrigin: 'auto',
    purpose,
    mode: 'local',
    cwd,
    workspaceId,
  };
  if (input.role) created.role = input.role;
  return createCliAgent(created);
}

/** The mission an additional agent in this workspace inherits: the first peer
 * that has one. Placeholder missions are still the workspace's stored brief;
 * refusing them makes an existing missionless workspace look empty. */
function inheritedPeerMission(peers: readonly { name: string }[]): string | null {
  for (const peer of peers) {
    const dbPath = agentDbPath(peer.name);
    if (!existsSync(dbPath)) continue;
    const db = new Database(dbPath, { readonly: true });
    try {
      const mission = readMission(makeSql(db));
      if (mission) return mission;
    } finally {
      db.close();
    }
  }
  return null;
}

/** What a local rename settled on: the slug it is addressed by, unchanged, and
 *  the title it now shows. */
export interface RenamedLocalAgent {
  name: string;
  displayName: string;
}

/**
 * Retitle a local agent on the owner's behalf.
 * Writes the agent's own naming state — the one title store — and marks it
 * the OWNER'S, which is what permanently stops `autoTitleLocalWorkspace`
 * from replacing it, since the shared `planWorkspaceTitle` refuses a `user`
 * origin. */
export function renameLocalAgent(name: string, displayName: string): RenamedLocalAgent {
  const title = displayName.trim();
  if (!title) throw new Error('A name is required.');
  const dbPath = agentDbPath(name);
  if (!existsSync(dbPath)) throw new Error(`Agent "${name}" not found.`);
  const db = new Database(dbPath);
  try {
    createAgentConfigStore(makeSql(db)).setDisplayNameOrigin(title, 'user');
  } finally {
    db.close();
  }
  return { name, displayName: title };
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

/**
 * The spec a fresh local workspace's `agent_config.model` is seeded with.
 *
 * An explicitly named model wins, then the operator's configured default, then
 * the endpoint's own spec. That last step used to be a SECOND copy of
 * cli-backend's `defaultProviderFor` table, and the copy had never gained the
 * `opencode`, `claude` or `@cf/` rows — so creating a workspace against a Claude
 * subscription wrote `openai-compat/<model>` and its first turn resolved the
 * wrong provider. One table, in the adapter that owns the endpoint.
 */
function modelSpecForAgentConfig(llm: LLMProviderConfig, rawModel: string | undefined): string {
  const configured = rawModel ?? loadConfigFile().model;
  if (configured) return configured;
  const derived = defaultSpecForEndpoint(llm);
  if (derived) return derived;
  throw new Error(`No model for "${llm.name}": name one with --model, or run kinu setup.`);
}
