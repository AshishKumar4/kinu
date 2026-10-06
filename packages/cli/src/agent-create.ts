import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  changeRoleAsOwner, openWorkspaceMainActor,
  DEFAULT_ROLE_ID,
  fallbackWorkspaceIdentity,
  initWorkspaceSchema,
  missionOf,
  workspaceSlug,
  type ReasoningEffort,
  type SuggestedWorkspaceIdentity,
} from '@kinu.run/core';
import { ensureDefaultTier, loadActiveProfile } from './default-model';
import { readDefaultTier } from './profiles';
import { createWorkspace } from '@kinu.run/core/workspace-birth';
import { makeSql, makeWorkspaceSchemaSql, soulIn, workspaceHome } from '@kinu.run/cli-backend';
import {
  agentDbPath,
  agentDir,
  canonicalProjectRoot,
  defaultVirtualWorkspaceId,
  ensureAgentHome,
  loadConfigFile,
  localWorkspaceMembers,
  placeLocalWorkspace,
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

export interface CreateCliAgentInput {
  /** Required for local agents; cloud agents are named from their mission. */
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
  cwd?: string;
  /** Defaults to the project's label, so two `kinu create` calls in one directory produce peers. */
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
  peers?: string[];
  aliasPath?: string;
}

/** The slug derives from the id; the title is the mission's stand-in, which the workspace's first turn names through its owed `auto_title` effect. */
export function suggestAgentIdentityFromMission(mission: string, id: string = crypto.randomUUID()): SuggestedWorkspaceIdentity {
  return fallbackWorkspaceIdentity(mission, id);
}

export interface CreateCloudAgentFromMissionOptions {
  id?: string;
  create: (input: CreateCloudAgentInput) => Promise<CloudAgent>;
}

export async function createCloudAgentFromMission(
  input: Pick<CreateCliAgentInput, 'name' | 'displayName' | 'nameOrigin' | 'purpose' | 'model' | 'baseUrl' | 'auth' | 'reasoningEffort' | 'role'>,
  options: CreateCloudAgentFromMissionOptions,
): Promise<CloudAgent> {
  const userNamed = Boolean(input.name) && input.nameOrigin !== 'auto';

  const identity = userNamed
    ? { name: input.name, displayName: input.displayName ?? input.name }
    : suggestAgentIdentityFromMission(input.purpose, options.id);

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

/** An unparseable config.json propagates rather than reading as a fresh install. */
export function isLocalModelConfigured(): boolean {
  try {
    // An OpenAI-compatible endpoint counts before it names a model.
    return resolveLLMConfig({ defaultModel: readDefaultTier()?.model }) !== null
      || loadConfigFile().providers?.openaiCompat?.default !== undefined;
  } catch (error) {
    // Only the half-set-override diagnostic means "not usable yet".
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

    // Pins only what was named, as the web creates it.
    const agent = await createCloudAgentFromMission({ ...input, purpose }, {
      create: (cloudInput) => createCloudAgent(auth.origin, auth.token, cloudInput),
    });

    await upsertAgentConfig({
      name: agent.name,
      mode: 'cloud',
      displayName: agent.displayName,
      cloudName: agent.name,
      alias: input.alias === '' ? undefined : input.alias,
    });
    const aliasPath = input.alias ? await writeAliasShim(agent.name, input.alias) : undefined;

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
  const tier = input.model === undefined ? await ensureDefaultTier() : readDefaultTier();
  const llmConfig = requireLLMConfig({ ...input, defaultModel: tier?.model });
  mkdirSync(agentDir(name), { recursive: true });

  // Built under a partial name and published by the rename (as `kinu import` does). `agent.db` existing is what
  // makes a directory a workspace, so the rename is the only visible transition; the next create clears a stale partial.
  const partial = `${dbPath}.partial`;
  discardPartialWorkspace(partial);
  const db = new Database(partial, { create: true });

  try {
    db.exec('PRAGMA journal_mode = WAL');
    // The slug (`workspace_identity.name`) addresses the workspace; the title heads SOUL.md and MEMORY.md.
    const rt = await createWorkspace(db, { name, title: displayName, purpose, llm: llmConfig, home: workspaceHome(db) });
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const agentConfig = rt.actor.config;

    if (input.model) agentConfig.setModel(input.model);

    if (input.reasoningEffort) agentConfig.setReasoningEffort(input.reasoningEffort);
    // The origin decides whether the title policy may ever rename this agent.
    agentConfig.setDisplayNameOrigin(displayName, input.nameOrigin ?? 'user');

    if (input.role && input.role !== DEFAULT_ROLE_ID) {
      changeRoleAsOwner({
        config: agentConfig, envelope: await loadActiveProfile(), to: input.role, active: DEFAULT_ROLE_ID,
      });
    }

    // Checkpoint before publishing; the close below then removes the empty sidecars, so the rename moves one file
    // and the next open makes fresh ones. It stays WAL: a DELETE file had the daemon's first open and the command's
    // race to switch it, and SQLite answers that race with BUSY without waiting out the busy timeout.
    db.query('PRAGMA wal_checkpoint(TRUNCATE)').get();
  } catch (error) {
    db.close();

    // Cleanup failures propagate: an unremovable partial blocks recreating this name.
    try {
      discardPartialWorkspace(partial);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `creating workspace "${name}" failed and its partial database at ${partial} could not be removed`,
        { cause: error },
      );
    }

    throw error;
  }

  db.close();
  // Publication. A crash before the ref below is written leaves a database with no folder, which every open refuses.
  renameSync(partial, dbPath);
  // Any sidecar left under the partial name belongs to a name that no longer exists.
  discardPartialWorkspace(partial);

  await placeLocalWorkspace({ name, cwd, workspaceId, alias: input.alias === '' ? undefined : input.alias });
  const aliasPath = input.alias ? await writeAliasShim(name, input.alias) : undefined;
  ensureLocalDaemonRunning();

  return {
    name, displayName, mode: 'local', purpose, model: input.model ?? tier?.model,
    dbPath, aliasPath, cwd, workspaceId, peers,
  };
}

/** Join the virtual workspace here with no name, mission or role: inherits a peer's mission, gets a stable
 * slug and a blank `auto` title. Refuses when there is no peer to inherit from. */
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
    // Neutral memorable pair plus id digits, never mission text.
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

/** First peer with a mission. Placeholder missions count; otherwise a missionless workspace looks empty. */
function inheritedPeerMission(peers: readonly { name: string }[]): string | null {
  for (const peer of peers) {
    const dbPath = agentDbPath(peer.name);

    if (!existsSync(dbPath)) continue;
    const mission = missionOf(soulIn(dirname(dbPath)));

    if (mission) return mission;
  }

  return null;
}

export interface RenamedLocalAgent {
  name: string;
  displayName: string;
}

/** Marks the title the owner's, which permanently stops the `auto_title` effect replacing it. */
export function renameLocalAgent(name: string, displayName: string): RenamedLocalAgent {
  const title = displayName.trim();

  if (!title) throw new Error('A name is required.');
  const dbPath = agentDbPath(name);

  if (!existsSync(dbPath)) throw new Error(`Agent "${name}" not found.`);
  const db = new Database(dbPath);

  try {
    openWorkspaceMainActor(makeSql(db)).config.setDisplayNameOrigin(title, 'user');
  } finally {
    db.close();
  }

  return { name, displayName: title };
}

function discardPartialWorkspace(partial: string): void {
  for (const path of [partial, `${partial}-wal`, `${partial}-shm`]) {
    rmSync(path, { force: true });
  }
}

/** Names are directories under `~/.kinu`, unique per machine; say which project holds it. */
function nameTaken(name: string, dbPath: string, held: { cwd?: string; workspaceId?: string } | null): string {
  const placement = held?.cwd && held.workspaceId
    ? ` It belongs to workspace "${held.workspaceId}" in ${held.cwd}.`
    : '';

  return `Workspace "${name}" already exists at ${dbPath}.${placement} Choose another name.`;
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
