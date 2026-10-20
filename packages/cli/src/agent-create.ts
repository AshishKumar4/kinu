import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  changeRoleAsOwner, openWorkspaceMainActor,
  DEFAULT_ROLE_ID,
  initWorkspaceSchema,
  missionOf,
  workspaceSlug,
  workspaceTitleProblem,
  type ReasoningEffort,
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
  resolveCloudSession,
  localWorkspaceMembers,
  placeLocalWorkspace,
  requireAuthConfig,
  requireModelDefaults,
  resolveAgentRef,
  resolveModelDefaults,
  upsertAgentConfig,
  validateWorkspaceId,
  type AgentMode,
} from './config';
import { createCloudAgent, type CreateCloudAgentInput } from './cloud-api';
import { authCommand } from './commands/auth';
import { ensureLocalDaemonRunning } from './commands/daemon';

export interface CreateCliAgentInput {
  /** Required for local agents; cloud agents are named from their mission. */
  name?: string;
  displayName?: string;
  nameOrigin?: 'user' | 'auto';
  purpose: string;
  mode: AgentMode;
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
}

/** Pins only what was named, as the web creates it. Only the owner's own name is sent: the server reads a sent name as
 *  theirs, so an unnamed workspace is named there, with a stand-in title the first turn's `auto_title` replaces. */
function cloudCreateInput(input: CreateCliAgentInput, purpose: string): CreateCloudAgentInput {
  const cloudInput: CreateCloudAgentInput = { purpose };

  if (input.name && input.nameOrigin !== 'auto') {
    cloudInput.name = input.name;
    cloudInput.displayName = input.displayName ?? input.name;
  }

  if (input.model) cloudInput.model = input.model;

  if (input.reasoningEffort) cloudInput.reasoningEffort = input.reasoningEffort;

  if (input.role) cloudInput.role = input.role;

  return cloudInput;
}

/** Signed in as `resolveCloudSession` decides: `KINU_TOKEN` counts, an expired stored session does not. */
export function isCloudAuthConfigured(): boolean {
  return resolveCloudSession() !== null;
}

/** An incomplete setup is not set up yet; an unparseable config.json propagates rather than reading as a fresh install. */
export function isLocalModelConfigured(): boolean {
  const defaults = resolveModelDefaults({ defaultModel: readDefaultTier()?.model });

  // An OpenAI-compatible endpoint counts before it names a model.
  return defaults.missing === null && (defaults.spec !== null || loadConfigFile().providers?.openaiCompat?.default !== undefined);
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

    const agent = await createCloudAgent(auth.origin, auth.token, cloudCreateInput(input, purpose));

    await upsertAgentConfig({
      name: agent.name,
      mode: 'cloud',
      displayName: agent.displayName,
      cloudName: agent.name,
    });

    return { name: agent.name, displayName: agent.displayName, mode: 'cloud', purpose, cloudName: agent.name };
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
  // A workspace no model could serve is refused before it is made.
  requireModelDefaults({ ...input, defaultModel: tier?.model });
  mkdirSync(agentDir(name), { recursive: true });

  // Built under a partial name and published by the rename (as `kinu import` does). `agent.db` existing is what
  // makes a directory a workspace, so the rename is the only visible transition; the next create clears a stale partial.
  const partial = `${dbPath}.partial`;
  discardPartialWorkspace(partial);
  const db = new Database(partial, { create: true });

  try {
    db.exec('PRAGMA journal_mode = WAL');
    // The slug (`workspace_identity.name`) addresses the workspace; the title heads SOUL.md and MEMORY.md.
    const rt = await createWorkspace(db, { name, title: displayName, purpose, home: workspaceHome(db) });
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

  await placeLocalWorkspace({ name, cwd, workspaceId });
  ensureLocalDaemonRunning();

  return {
    name, displayName, mode: 'local', purpose, model: input.model ?? tier?.model,
    dbPath, cwd, workspaceId, peers,
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
  // The one title rule the cloud's rename and every editor run, so a title kept here is one the cloud keeps.
  const problem = workspaceTitleProblem(displayName);

  if (problem !== null) throw new Error(problem);
  const title = displayName.trim();
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
