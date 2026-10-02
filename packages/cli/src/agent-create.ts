import { Cause, Effect } from 'effect';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { generateText } from 'ai';
import {
  WORKSPACE_TITLE_SYSTEM_PROMPT,
  workspaceTitlePrompt,
  agentAffinityKey,
  changeRoleAsOwner, openWorkspaceMainActor,
  DEFAULT_ROLE_ID,
  fallbackWorkspaceIdentity,
  initWorkspaceSchema,
  parseWorkspaceTitle,
  readMission,
  workspaceSlug,
  type ReasoningEffort,
  type SuggestedWorkspaceIdentity,
} from '@kinu.run/core';
import { ensureDefaultTier, loadActiveProfile } from './default-model';
import { readDefaultTier } from './profiles';
import { createWorkspace } from '@kinu.run/core/workspace-birth';
import { diagnostics, renderThrownChain, settle, settleSync } from '@kinu.run/core/obs';
import { makeSql, makeWorkspaceSchemaSql } from '@kinu.run/cli-backend';
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

export interface SuggestAgentIdentityOptions {
  id?: string;
  model?: string;
  baseUrl?: string;
  auth?: string;
  signal?: AbortSignal;
  generate?: (mission: string, signal?: AbortSignal) => Promise<string>;
}

/** The slug derives from the id only; the title is generated when possible, mission-derived otherwise. */
export function suggestAgentIdentityFromMission(
  mission: string,
  opts: SuggestAgentIdentityOptions = {},
): Promise<SuggestedWorkspaceIdentity> {
  return settle(Effect.gen(function* () {
    const fallback = fallbackWorkspaceIdentity(mission, opts.id ?? crypto.randomUUID());

    return yield* Effect.catchCause(Effect.gen(function* () {
      const generate = opts.generate;

      const raw = generate
        ? (yield* Effect.promise(async () => generate(mission, opts.signal)))
        : (yield* Effect.promise(async () => generateTitleJson(mission, opts, agentAffinityKey(fallback.name))));

      const title = parseWorkspaceTitle(raw);

      if (opts.signal?.aborted) return yield* Effect.die(opts.signal.reason);

      return title ? { ...fallback, displayName: title } : fallback;
    }), (failed) => Effect.gen(function* () {
      const error = Cause.squash(failed);

      if (opts.signal?.aborted) return yield* Effect.die(opts.signal.reason);
      diagnostics.event('agent.title_fallback', { error: renderThrownChain({ cause: error }) });

      return fallback;
    }));
  }));
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

/** An unparseable config.json propagates rather than reading as a fresh install. */
export function isLocalModelConfigured(): boolean {
  return settleSync(Effect.gen(function* () {
    return yield* Effect.catchCause(Effect.sync(() => {
      // An OpenAI-compatible endpoint counts before it names a model.
      return resolveLLMConfig({ defaultModel: readDefaultTier()?.model }) !== null
        || loadConfigFile().providers?.openaiCompat?.default !== undefined;
    }), (failed) => Effect.gen(function* () {
      const error = Cause.squash(failed);
      // Only the half-set-override diagnostic means "not usable yet".

      if (error instanceof Error && error.message.startsWith('No LLM auth configured')) return false;

      return yield* Effect.failCause(failed);
    }));
  }));
}

export function defaultCreateMode(): AgentMode {
  return isCloudAuthConfigured() ? 'cloud' : 'local';
}

export function createCliAgent(input: CreateCliAgentInput): Promise<CreatedCliAgent> {
  return settle(Effect.gen(function* () {
    ensureAgentHome();
    const purpose = input.purpose.trim();

    if (!purpose) return yield* Effect.die(new Error('Mission required.'));

    if (input.mode === 'cloud') {
      const auth = yield* resolveCloudAuth(input.origin, input.allowInteractiveAuth === true);

      // Pins only what was named, as the web creates it.
      const agent = yield* Effect.promise(async () => createCloudAgentFromMission({ ...input, purpose }, {
        create: (cloudInput) => createCloudAgent(auth.origin, auth.token, cloudInput),
      }));

      yield* Effect.promise(async () => upsertAgentConfig({
        name: agent.name,
        mode: 'cloud',
        displayName: agent.displayName,
        cloudName: agent.name,
        alias: input.alias === '' ? undefined : input.alias,
      }));
      const alias = input.alias;
      const aliasPath = alias ? (yield* Effect.promise(async () => writeAliasShim(agent.name, alias))) : undefined;

      return { name: agent.name, displayName: agent.displayName, mode: 'cloud', purpose, cloudName: agent.name, aliasPath };
    }

    const name = input.name;

    if (!name) return yield* Effect.die(new Error('Agent name required for a local workspace.'));
    const displayName = input.displayName ?? name;
    const cwd = canonicalProjectRoot(input.cwd);
    const workspaceId = input.workspaceId ?? defaultVirtualWorkspaceId(cwd);
    validateWorkspaceId(workspaceId);
    const claimed = resolveAgentRef(name);

    if (claimed && claimed.mode !== 'local') {
      return yield* Effect.die(new Error(`"${name}" is already a cloud workspace. Choose another name.`));
    }

    const dbPath = agentDbPath(name);

    if (existsSync(dbPath)) return yield* Effect.die(new Error(nameTaken(name, dbPath, claimed)));
    // Read before the workspace exists, so it reports who this agent JOINS.
    const peers = localWorkspaceMembers(workspaceId, cwd).map((peer) => peer.name);
    const tier = input.model === undefined ? (yield* Effect.promise(async () => ensureDefaultTier())) : readDefaultTier();
    const llmConfig = requireLLMConfig({ ...input, defaultModel: tier?.model });
    mkdirSync(agentDir(name), { recursive: true });

    // Built under a partial name and published by the rename (as `kinu import` does). `agent.db` existing is what
    // makes a directory a workspace, so the rename is the only visible transition; the next create clears a stale partial.
    const partial = `${dbPath}.partial`;
    discardPartialWorkspace(partial);
    const db = new Database(partial, { create: true });

    yield* Effect.catchCause(Effect.gen(function* () {
      db.exec('PRAGMA journal_mode = WAL');
      // The slug (`workspace_identity.name`) addresses the workspace; the title heads SOUL.md and MEMORY.md.
      const rt = yield* Effect.promise(async () => createWorkspace(db, { name, title: displayName, purpose, llm: llmConfig }));
      initWorkspaceSchema(makeWorkspaceSchemaSql(db));
      const agentConfig = rt.actor.config;

      if (input.model) agentConfig.setModel(input.model);

      if (input.reasoningEffort) agentConfig.setReasoningEffort(input.reasoningEffort);
      // The origin decides whether the title policy may ever rename this agent.
      agentConfig.setDisplayNameOrigin(displayName, input.nameOrigin ?? 'user');

      if (input.role && input.role !== DEFAULT_ROLE_ID) {
        changeRoleAsOwner({
          config: agentConfig, envelope: yield* Effect.promise(async () => loadActiveProfile()), to: input.role, active: DEFAULT_ROLE_ID,
        });
      }

      // Checkpoint and leave WAL before publishing: the rename drops the sidecars, and a WAL db without `-shm`
      // fails to open (SQLITE_IOERR_SHORT_READ / SQLITE_IOERR_VNODE). `openWorkspaceCLI` restores WAL.
      db.query('PRAGMA wal_checkpoint(TRUNCATE)').get();
      db.exec('PRAGMA journal_mode = DELETE');
    }), (failed) => Effect.gen(function* () {
      const error = Cause.squash(failed);
      db.close();

      // Cleanup failures propagate: an unremovable partial blocks recreating this name.
      yield* Effect.catchCause(Effect.sync(() => {
        discardPartialWorkspace(partial);
      }), (cleanupFailed) => Effect.gen(function* () {
        const cleanupError = Cause.squash(cleanupFailed);

        return yield* Effect.die(new AggregateError(
          [error, cleanupError],
          `creating workspace "${name}" failed and its partial database at ${partial} could not be removed`,
          { cause: error },
        ));
      }));

      return yield* Effect.failCause(failed);
    }));

    db.close();
    // Publication. Past here an unregistered agent.db is converged by adoption (`adoptUnplacedLocalAgent`).
    renameSync(partial, dbPath);
    // The checkpointed (empty) sidecars belong to a name that no longer exists.
    discardPartialWorkspace(partial);

    yield* Effect.promise(async () => upsertAgentConfig({
      name,
      mode: 'local',
      localName: name,
      alias: input.alias === '' ? undefined : input.alias,
      cwd,
      workspaceId,
      // The db's durable id, so creation and adoption record the same identity.
      identityId: readWorkspaceIdentityId(dbPath) ?? undefined,
    }));
    const alias = input.alias;
    const aliasPath = alias ? (yield* Effect.promise(async () => writeAliasShim(name, alias))) : undefined;
    ensureLocalDaemonRunning();

    return {
      name, displayName, mode: 'local', purpose, model: input.model ?? tier?.model,
      dbPath, aliasPath, cwd, workspaceId, peers,
    };
  }));
}

/** Join the virtual workspace here with no name, mission or role: inherits a peer's mission, gets a stable
 * slug and a blank `auto` title. Refuses when there is no peer to inherit from. */
export function createLocalPeerAgent(
  input: { cwd?: string; workspaceId?: string; role?: string } = {},
): Promise<CreatedCliAgent> {
  return settle(Effect.gen(function* () {
    ensureAgentHome();
    const cwd = canonicalProjectRoot(input.cwd);
    const workspaceId = input.workspaceId ?? defaultVirtualWorkspaceId(cwd);
    validateWorkspaceId(workspaceId);
    const peers = localWorkspaceMembers(workspaceId, cwd);
    const purpose = inheritedPeerMission(peers);

    if (!purpose) {
      return yield* Effect.die(new Error(
        `No agent in workspace "${workspaceId}" to inherit a mission from. `
        + 'Create the first one with: kinu create',
      ));
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

    return yield* Effect.promise(async () => createCliAgent(created));
  }));
}

/** First peer with a mission. Placeholder missions count; otherwise a missionless workspace looks empty. */
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

export interface RenamedLocalAgent {
  name: string;
  displayName: string;
}

/** Marks the title the owner's, which permanently stops `autoTitleLocalWorkspace` replacing it. */
export function renameLocalAgent(name: string, displayName: string): RenamedLocalAgent {
  return settleSync(Effect.gen(function* () {
    const title = displayName.trim();

    if (!title) return yield* Effect.die(new Error('A name is required.'));
    const dbPath = agentDbPath(name);

    if (!existsSync(dbPath)) return yield* Effect.die(new Error(`Agent "${name}" not found.`));
    const db = new Database(dbPath);

    yield* Effect.ensuring(Effect.sync(() => {
      openWorkspaceMainActor(makeSql(db)).config.setDisplayNameOrigin(title, 'user');
    }), Effect.sync(() => {
      db.close();
    }));

    return { name, displayName: title };
  }));
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

/** `conversation`: the new workspace's, as its first model call. */
async function generateTitleJson(mission: string, opts: SuggestAgentIdentityOptions, conversation: string): Promise<string> {
  const { resolver } = createConfiguredLocalModelResolver(opts);

  const result = await generateText({
    model: resolver.resolveModel(opts.model ?? null, conversation),
    system: WORKSPACE_TITLE_SYSTEM_PROMPT,
    prompt: workspaceTitlePrompt(mission),
    abortSignal: opts.signal,
    // No output cap: reasoning models spend it thinking and return empty text. Cheapness comes from low effort.
  });

  return result.text;
}

function resolveCloudAuth(origin: string | undefined, allowInteractiveAuth: boolean): Effect.Effect<{ origin: string; token: string }> {
  return Effect.gen(function* () {
    return yield* Effect.catchCause(Effect.sync(() => {
      return requireAuthConfig();
    }), (failed) => Effect.gen(function* () {
      if (!allowInteractiveAuth || !process.stdin.isTTY || !process.stdout.isTTY) return yield* Effect.failCause(failed);
      yield* Effect.promise(async () => authCommand({ origin }));

      return requireAuthConfig();
    }));
  });
}
