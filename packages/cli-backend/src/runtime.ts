import type { ModelAttemptIdentity } from '@kinu.run/core';
import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * Local CLI runtime factory: an agent's file plane is the workspace's folder and its space on this machine
 * (`localFilePlane`), over the workspace's one SQLite database.
 */

import type { Database } from 'bun:sqlite';
import type {
  AgentRuntime, ActorHandle, BoundActor, ModelRouteResolution,
  ResolvedTurnProfile, Shell, ShellExecOptions, ShellExecResult, OutputSpill, SpillOutcome, VfsMount,
} from '@kinu.run/core';
import type { Memory, RoutedLLM, Schedule, SqlExec, SqlExecutor, RawSqlExec, WorkspaceSchemaSql } from '@kinu.run/core';
import type { DeferredApprovalChannel, FilesOwner, RequestShellApproval, ShellApprovalPolicy } from '@kinu.run/core';
import { spawn } from 'node:child_process';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, chmodSync, writeSync } from 'node:fs';
import { homedir, constants as osConstants } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import {
  type LLMProviderConfig, type SessionFilePlane, actorScaffoldPath, actorReferenceOf, buildRuntime, agentHome, agentArtifactDirectory, actorHomeName, actorAffinity, MAIN_AGENT,
  observeNamespace, type WriteObserver,
  WORKSPACE_IDENTITY_DDL,
  answerParentRpc, createParentExecutor,
  type ParentWorkspaceHandle,
  DefaultExecutionRouter,
  adaptMemory,
  withApprovalGatedShell, withApprovalGatedFiles, createShellSession, createBashShell, holdsGrant, createInheritedApprovalPolicy,
  initFiberTable, initDriverLeaseTable, initJobHoldersTable, initWorkspaceActorTable, bearWorkspaceIdentity, stampSchemaGenesis, initActorStateSchema, initAgentConfigTable, initScaffoldTables,
  createAgentStores, contextMount, skillsMount,
  resolveRoutingProfile, createRoutedModelLane, routedLlm, bindRoute, tierRefusals, type TierRefusals,
  type AgentStores, type ChildContextResolver,
  type ModelCallSink, type ModelOperationSink,
  BoundedOutput, COMMAND_OUTPUT_LIMITS, nanoid, SPILL_DIRS, unsandboxedCommandEnvironment,
} from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';
import { localNodeRuntime } from './node-runtime';
import { actorFilePlane, ownContextTree } from './actor-plane';
import { MemoryStore } from '@kinu.run/agent-utils';
import { CraftStore } from '@kinu.run/agent-utils';
import { createSandboxedExecutor } from './executor';
import { createHostCheckpoints } from './checkpoints';
import { kinuHome } from './home';
import { hostWorkspaceExecutor } from './host-toolchain';
import { agentHomeFiles, localFilePlane, localFileReach, spaceFiles, type LocalPlane } from './host-mount';
import { sqlStorageOver, wrapDatabase } from '@kinu.run/core/identity';
import { createSqlFiber, detectOrphanedFibers, localPlanes, SOUL_PATH } from '@kinu.run/core';
import { createDecisionPort, createStructuredDecider, decisionPortOf, restDecisionRun } from '@kinu.run/core';
import { readLaunchDotenv } from './dotenv-provenance';
import {
  createLocalModelResolver, workersAiRoute,
  type LocalCloudSession, type LocalModelResolver, type ProviderCredentialSource,
} from './model-resolver';
import {
  createLocalProfileAuthority,
  type LocalProfileAuthority, type LocalProfileModelPlane,
} from './profile-authority';
import type { LocalOAuthStore } from './oauth-store';
import type { FileCheckpoints } from '@kinu.run/core';
import { detach, diagnostics, KinuError, renderCauseChain, settleLogged, settleSync, toKinuError } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import { adoptLocalActorHandle, localActorDirectory, bindLocalActor, bindLocalActorReference, openLocalRootActor, requireLocalActorWorkspace, type LocalActorConfig, type LocalActorBinding } from '@kinu.run/core';
import * as v from 'valibot';

/** Where a local owner changes a tier's model, as a refusal notice names it. */
const LOCAL_MODEL_SETTINGS = 'your model settings';

interface CLIRuntimeOptions {
  /**
   * The folder the workspace works in. Required: a local workspace's files are this machine's, and its own space
   * is the directory beside its database (2026-10-04). Never `process.cwd()` by default: an eval would write into
   * the developer's repo.
   */
  cwd: string;
  /** An endpoint this process was given (`--base-url` and `--auth`), served as itself; null without one. The stored
   *  chat model (actor_config) drives the seams. */
  llm: LLMProviderConfig | null;
  /** The model a bare id or no choice means; absent, the given endpoint's own. */
  defaultSpec?: string | null;
  /** The stores the host bound this actor with, where it bound it before its runtime: one bundle per actor. */
  stores?: AgentStores;
  agentName?: string;
  providerCredentials?: ProviderCredentialSource;
  oauthStore?: LocalOAuthStore;
  /** The signed-in Kinu session: the decision model's route when `llm` serves no Workers AI (`workersAiRoute`). */
  cloud?: LocalCloudSession;
  /** Shadow-git checkpoints kept per working directory. */
  checkpointKeep?: number;
}


/** An actor's own `/context` tree over its own stores in this process. */
export type CLIRuntimeConfig = CLIRuntimeOptions & LocalActorConfig;

/**
 * The local runtime plus late-bound session channels: model seams are built before
 * any session, but their usage belongs in the session's run-event log.
 */
export interface CLIRuntime extends AgentRuntime {
  /** The reflection lane: routed, so it answers to a schema where a fast lane is absent. */
  llm: RoutedLLM;
  filesForActor: (actor: ActorHandle) => Promise<SessionFilePlane>;
  /** Gates shells and tool files, a head's too. */
  approvalPolicy: ShellApprovalPolicy;
  setApprovalDeferrals?(channel: DeferredApprovalChannel | null): void;
  setModelCallSink?(sink: ModelCallSink | null): void;
  /** Lifecycle sink bound beside {@link setModelCallSink}. */
  setModelOperations?(sink: ModelOperationSink | null): void;
  /** The folder it works in. See CLIRuntimeConfig.cwd. */
  cwd: string;
  space: string;
  ownFiles: VFS;
  plane: LocalPlane;
  memoryStore: MemoryStore;
  setModelForRoute?(factory: (resolution: ModelRouteResolution) => RoutedLLM): void;
  modelForRoute?: (resolution: ModelRouteResolution) => RoutedLLM;
  /** A facet's lanes share its parent's credential lookup and refusal notices. */
  attemptOf?: (spec: string) => Promise<ModelAttemptIdentity | null>;
  /** The actor's one notice state for its runtime's life; the session's titling says through it too. */
  refusals: TierRefusals;
  /**
   * Fallback turn-profile authority, so a session-less runtime (`kinu evolve`) still
   * routes. A session refines its inputs rather than installing a second resolver.
   */
  profiles?: LocalProfileAuthority;
  /**
   * Override seam for harnesses (`tests/live-model/harness.ts`); `null`
   * withholds resolution so an unrouted lane says so rather than inventing a model.
   */
  setProfileResolver?(resolve: (() => Promise<ResolvedTurnProfile>) | null): void;
  /** The issued operation's profile, or current authority for new work. */
  ensureProfile?: () => Promise<ResolvedTurnProfile>;
  /** The agent's own gated, checkpointed host shell; a swarm node it seats runs in it too. */
  shell: Shell;
  /** A facet's gated, checkpointed host shell with its own `HOME`/`TMPDIR`. */
  facetShell: (facet: string) => Shell;
  /** Shared rather than rebuilt per consumer: two instances over one actor are two memos of one truth. */
  stores: AgentStores;
  /**
   * Late-bound: the resolver belongs to the root's ActorHost, built after this
   * runtime. Unset manages and lists nothing.
   */
  setChildContext?(resolver: ChildContextResolver | null): void;
}

export type LocalDb = Database;

export function makeSql(db: Database): SqlExecutor {
  return wrapDatabase(db).sql;
}

export function makeExecRaw(db: { exec(sql: string): void }): RawSqlExec {
  return (ddl: string) => db.exec(ddl);
}

/** Main's memory over its notes: the one its memory tool, and `kinu memory`, read and search. */
function notesMemory(notes: ReturnType<typeof agentHomeFiles>, sql: SqlExecutor, transactionSync: (write: () => void) => void) {
  const store = new MemoryStore(notes, sql, transactionSync);
  store.ensureSchema();

  return { store, memory: adaptMemory(store, notes) };
}

/** The memory of the workspace whose database `db` is, as its memory tool reads and searches it. */
export function workspaceMemory(db: Database): Memory {
  return notesMemory(workspaceHome(db), makeSql(db), write => db.transaction(write)()).memory;
}

/** Session payload reads for inspection, over the workspace's folder and own space. */
export function inspectionFiles(db: Database, cwd: string): Pick<VFS, 'readFile'> {
  return settleSync(Effect.map(ownSpaceOf(db), (space) => localFilePlane({ folder: cwd, space, views: [], checkpoints: undefined })));
}

/** Positional-binding SQL; a Durable Object's `ctx.storage.sql` is this natively. */
export function makeSqlExec(db: Pick<Database, 'query'>): SqlExec {
  return sqlStorageOver(db);
}

/** All onto one database, so no caller can pair a DDL handle with another file's reads. */
export function makeWorkspaceSchemaSql(db: LocalDb): WorkspaceSchemaSql {
  return { execRaw: makeExecRaw(db), sql: makeSql(db), exec: makeSqlExec(db), transactionSync: (write) => writeTransaction(db, write) };
}

/** A lock held longer than this is a hung opener, and the write fails naming the lock. */
const SHARED_WRITE_WAIT_MS = 30_000;

/** The daemon and a chat share one workspace file, and bun:sqlite fails a write meeting the other's at once, so
 *  a write waits. Set first: opening itself writes. */
export function waitOnSharedWrites(db: Database): void {
  db.exec(`PRAGMA busy_timeout = ${String(SHARED_WRITE_WAIT_MS)}`);
}

/** IMMEDIATE: a deferred one that read first fails at once on another process's write, busy timeout or not. */
export function writeTransaction<T>(db: Pick<Database, 'transaction'>, body: () => T): T {
  return db.transaction(body).immediate();
}

export function createCLIRuntime(db: Database, config: CLIRuntimeConfig): CLIRuntime {
  const cwd = resolvePath(config.cwd);

  return settleSync(Effect.map(ownSpaceOf(db), (space) => buildCLIRuntime(db, config, { cwd, space })));
}

function buildCLIRuntime(
  db: Database,
  config: CLIRuntimeConfig,
  place: { readonly cwd: string; readonly space: string },
): CLIRuntime {
  waitOnSharedWrites(db);
  db.exec('PRAGMA foreign_keys = ON');

  // WAL with NORMAL: a commit waits on no fsync. A process crash keeps every commit; a power loss can roll back the
  // last few, never corrupt the file. A rollback-journal file keeps FULL, where NORMAL could corrupt it.
  if (db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode === 'wal') db.exec('PRAGMA synchronous = NORMAL');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);

  initFiberTable(execRaw);

  let actor: ActorHandle;
  let agentName: string;

  if (config.facet !== undefined) {
    if (!config.actorBinding) throw new KinuError('missing', 'A local facet requires its root-issued actor binding.');
    initActorStateSchema(makeWorkspaceSchemaSql(db));
    actor = config.actor ?? bindLocalActor(sql, config.actorBinding);
    agentName = config.actorBinding.name;
  } else {
    execRaw(WORKSPACE_IDENTITY_DDL);
    // The root's local tables, made with it so its stamp covers them; the lease and the job holders fill them on use.
    initDriverLeaseTable(execRaw);
    initJobHoldersTable(execRaw);
    const existing = sql<{ name: string }>`SELECT name FROM workspace_identity LIMIT 1`[0];

    if (existing) {
      agentName = existing.name;
    } else {
      agentName = config.agentName ?? 'agent';
      stampSchemaGenesis(execRaw);
      initWorkspaceActorTable(execRaw);
      bearWorkspaceIdentity(sql, { name: agentName, createdAt: Date.now() });
    }

    actor = openLocalRootActor(sql);
  }

  // After the branch binds an actor: an unscoped sweep would resume a sibling's lane.
  const orphans = detectOrphanedFibers(sql, actor);

  if (orphans.length > 0) {
    diagnostics.failure(
      'fiber.orphans_detected',
      new KinuError('cancelled', 'fibers from a previous run were interrupted by its exit'),
      { orphans: orphans.length },
    );
  }

  // Built before any session, so each seam reports through a slot the session
  // fills (setModelCallSink). Unbound means unattributed spend, never free spend.
  let modelCallSink: ModelCallSink | null = null;
  const report: ModelCallSink = (call) => modelCallSink?.(call);
  let modelOperations: ModelOperationSink | null = null;
  const operations: ModelOperationSink = (event) => modelOperations?.(event);
  // DDL here too: a runtime built without `initWorkspaceSchema` (branch worker,
  // `kinu evolve`, fixture) still reads the table on its first gated command.
  initAgentConfigTable(execRaw);
  initScaffoldTables(execRaw);
  const agentConfig = actor.config;
  // The one registry the routed lanes call and spell a tier's model by.
  let specResolver: LocalModelResolver | null = null;

  const localResolver = (): LocalModelResolver => {
    specResolver ??= createLocalModelResolver({
      llm: config.llm,
      defaultSpec: config.defaultSpec,
      credentials: config.providerCredentials,
      oauthStore: config.oauthStore,
    });

    return specResolver;
  };

  const profilePlane: LocalProfileModelPlane = {
    normalizeSpec: (spec) => localResolver().normalizeSpecSync(spec),
    // Claims nothing it did not look up; a session that can list refines it.
    listModels: () => Promise.resolve({ models: [], failures: [] }),
  };

  const profiles = createLocalProfileAuthority({ config: agentConfig, plane: profilePlane });

  // Every local runtime routes, session-less ones included.
  let profileResolver: (() => Promise<ResolvedTurnProfile>) | null =
    () => profiles.resolvePreTurn();

  const ensureProfile = (): Promise<ResolvedTurnProfile> => resolveRoutingProfile({
    actor,
    resolve: () => {
      if (!profileResolver) throw new Error('this runtime has no profile resolver: model lanes cannot route before a turn');

      return profileResolver();
    },
  });

  // Core's one routed invocation over the local registry; a spec is spelled as the registry spells it, so spend is too.
  const localRegistry = {
    normalize: (spec: string) => localResolver().normalizeSpecSync(spec),
    resolve: (spec: string) => localResolver().resolveModel(spec, actorAffinity(actor)),
  };

  let modelRouteFactory = (resolution: ModelRouteResolution): RoutedLLM => routedLlm(
    (route) => bindRoute(localRegistry, route),
    { ...resolution, model: localRegistry.normalize(resolution.model) },
    { report, operations },
  );

  const modelForRoute = (resolution: ModelRouteResolution): RoutedLLM =>
    modelRouteFactory(resolution);

  const attemptOf = (spec: string): Promise<ModelAttemptIdentity | null> => localResolver().attemptFor(spec);
  // A local session reads the owner's model settings as it opens; nothing changes them under it.
  const refusals = tierRefusals({ sql, actor, config: agentConfig, now: Date.now, settings: LOCAL_MODEL_SETTINGS, changes: () => 0 });

  const modelLanes = {
    resolveProfile: ensureProfile,
    llm: modelForRoute,
    attemptOf,
    refusals,
  };

  const llm = createRoutedModelLane(actor, 'reflection', modelLanes);

  const decisionEndpoint = workersAiRoute(config.llm, config.cloud)?.auth;

  // `/ai/run` beside a chat model's `/ai/v1`: only Cloudflare's API and the worker's proxy serve one. Elsewhere Clef
  // refuses as unconnected, said once, and the fast tier answers what its measured agreement trusts it with.
  const servesRun = /\/ai\/v1\/?$/.test(decisionEndpoint?.baseURL ?? '');

  const decide = decisionPortOf(createDecisionPort({
    run: restDecisionRun({ getAuth: async () => (servesRun ? decisionEndpoint ?? null : null) }),
    model: async () => (await ensureProfile()).decisionModel,
    report,
    refusals,
  }), createStructuredDecider(actor, modelLanes));

  const schedule: Schedule = {
    // Unreferenced so a one-shot `kinu` command still exits with a timer pending.
    after: async (ms, fn) => {
      // No caller remains when this runs; a rejection is recorded as a domain failure.
      const deferred = (): Promise<void> => settleLogged('schedule.deferred_failed', {
        doing: 'running work this session deferred', otherwise: 'io',
      }, fn);

      const timer = setTimeout(() => detach(Effect.promise(deferred)), Math.max(0, ms));
      timer.unref?.();
    },
    cron: async () => {},
    fiber: createSqlFiber(sql, actor),
  };

  const checkpoints = createHostCheckpoints({ agent: agentName, keep: config.checkpointKeep });
  const { cwd, space } = place;
  const agentStateVfs = agentHomeFiles(space, MAIN_AGENT);
  // The host's bundle where it bound this actor first; one actor has one.
  const stores = config.stores ?? createAgentStores(() => sql, () => actor, (write) => writeTransaction(db, write), () => filesForActor(actor));
  let childContext: ChildContextResolver | null = null;

  const ownFiles = spaceFiles(space);

  const views: VfsMount[] = [
    skillsMount((): VFS => ownFiles),
    // This actor's own working history.
    contextMount({
      actorId: actor.actorId,
      own: ownContextTree(actor, stores),
      children: {
        list: () => childContext?.list() ?? [],
        tree: (storageKey, author) => childContext?.tree(storageKey, author) ?? null,
      },
    }),
  ];

  const { planes, home: ownHome } = runtimePlanes(cwd, space, config.facet, views);

  const { store: memoryStore, memory } = notesMemory(agentStateVfs, sql, write => db.transaction(write)());

  const craftStore = new CraftStore(sql);
  craftStore.ensureSchema();
  let approvalChannel: RequestShellApproval | null = null;
  let approvalDeferrals: DeferredApprovalChannel | null = null;

  const ownerPolicy: ShellApprovalPolicy = {
    mode: () => agentConfig.getShellApprovalMode(),
    granted: (grant) => holdsGrant(agentConfig.getShellApprovalGrants(), grant),
    requestApproval: (request, signal) => approvalChannel?.(request, signal) ?? Promise.resolve(null),
    get deferrals() { return approvalDeferrals ?? undefined; },
  };

  // As on the cloud: grants are written on the root's rows, so a child inherits the root's answers
  // intersected with its own narrowing, and cannot remember or ask for wider reach. A gated command it runs parks on
  // the workspace's one queue, as the root's do.
  const approvalPolicy: ShellApprovalPolicy = config.facet === undefined
    ? ownerPolicy
    : createInheritedApprovalPolicy({
      fetchRoot: async () => {
        const root = openLocalRootActor(sql).config;

        return { mode: root.getShellApprovalMode(), grants: root.getShellApprovalGrants() };
      },
      ownGrants: () => agentConfig.getShellApprovalGrants(),
      deferrals: () => approvalDeferrals ?? undefined,
    });

  // The shell runs on the user's machine and may mutate the tree, so it snapshots first.
  const filesOwner: FilesOwner = 'user';

  // Each call is a fresh `sh -c`; a named one keeps its directory and exports in a file under KINU_HOME, per agent.
  // Every workspace's shells share that directory, and a facet's home is unique only in its own workspace.
  const facetShell = (facet: string | undefined): Shell => {
    const bash = createBashShell(createHostShell(cwd, facet === undefined ? process.env : facetShellEnv(space, facet)), {
      home: cwd, scope: facet === undefined ? agentName : `${actor.workspaceId}/${facet}`, stateDirectory: join(kinuHome(), 'shells'),
    });

    // A named shell resumes where an earlier process left it, so its review starts there too.
    const shellSession = createShellSession({ home: cwd, userRoots: () => [], stored: async (name) => await bash.cwd?.(name) ?? null });

    // The host shell serves no mount table: `/pc` there is the machine's own path. Its files are the user's anywhere.
    return withApprovalGatedShell(withCheckpointedShell(bash, checkpoints, cwd), { filesOwner, shellSession, planes }, approvalPolicy);
  };

  const shell = facetShell(config.facet);

  const executionRouter = new DefaultExecutionRouter(approvalPolicy);

  const filesForActor = async (target: ActorHandle): Promise<SessionFilePlane> => {
    const record = localActorDirectory(actor).directory.describe(target);
    adoptLocalActorHandle(actor, actorReferenceOf(target), target);
    requireLocalActorWorkspace(actor, target);

    const artifactDirectory = agentArtifactDirectory(join(space, agentHome(actorHomeName(record))));
    mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
    chmodSync(artifactDirectory, 0o700);
    target.assertCurrent();

    return { vfs: agentVfs, artifactDirectory };
  };

  const agentVfs = localFilePlane({ folder: cwd, space, views, checkpoints });

  // Only the agent's tools: the shell and the owner's views keep `agentVfs`.
  const toolFiles = withApprovalGatedFiles(agentVfs, 'workspace', localFileReach({ folder: cwd, space }, planes, agentVfs), approvalPolicy);

  executionRouter.register(hostWorkspaceExecutor({
    vfs: toolFiles, files: agentVfs, home: ownHome, planes, craftStore, shell, sql, actor,
  }));

  const runtime: CLIRuntime = Object.assign(buildRuntime({
    transactionSync: write => writeTransaction(db, write),
    ...(config.actorBinding !== undefined && { scaffoldPath: actorScaffoldPath(config.actorBinding) }),
    planes,
    actor, sql,
    execRaw,
    vfs: agentVfs,
    home: ownHome,
    agentStateVfs,
    toolFiles,
    llm,
    executor: createSandboxedExecutor(),
    schedule,
    memory,
    craftStore,
    modelLanes,
    decide,
    executionRouter, shell, checkpoints,
    setShellApprovalChannel: (fn) => { approvalChannel = fn; },
  }), {
    // The reflection lane as built here: routed, so it answers to a schema.
    llm,
    stores,
    filesForActor,
    approvalPolicy,
    setApprovalDeferrals: (channel: DeferredApprovalChannel | null) => { approvalDeferrals = channel; },
    setChildContext: (resolver: ChildContextResolver | null) => { childContext = resolver; },
    cwd,
    space,
    ownFiles,
    plane: agentVfs,
    memoryStore,
    shell,
    facetShell,
    setModelCallSink: (sink: ModelCallSink | null) => { modelCallSink = sink; },
    setModelOperations: (sink: ModelOperationSink | null) => { modelOperations = sink; },
    profiles,
    modelForRoute,
    attemptOf,
    refusals,
    setModelForRoute: (factory: (resolution: ModelRouteResolution) => RoutedLLM) => {
      modelRouteFactory = factory;
    },
    setProfileResolver: (resolve: (() => Promise<ResolvedTurnProfile>) | null) => {
      profileResolver = resolve;
    },
    ensureProfile,
  });

  return runtime;
}

/** Join one facet to its parent's workspace: the same folder and own space, so only checkpoints and the soul are shared. */
export function shareLocalWorkspacePlane(actor: CLIRuntime, workspace: CLIRuntime): CLIRuntime {
  requireLocalActorWorkspace(workspace.actor, actor.actor);

  if (actor.cwd !== workspace.cwd || actor.space !== workspace.space) {
    throw new KinuError('bad_input', `a hire works in its workspace's folder ${workspace.cwd}, not ${actor.cwd}`);
  }

  return Object.assign(actor, { checkpoints: workspace.checkpoints });
}

/**
 * One facet's `HOME`/`TMPDIR` scratch: its own home in the own space. No uid
 * separation exists there, so isolation stays `shared-origin-plane`. The name is
 * validated (`agentHome`) so `/` or `..` cannot reach the join.
 */
function facetShellEnv(space: string, facet: string): NodeJS.ProcessEnv {
  const home = join(space, agentHome(facet));
  const tmp = join(home, 'tmp');
  mkdirSync(tmp, { recursive: true });

  return { ...process.env, HOME: home, TMPDIR: tmp };
}

export function cleanupFacetScratch(space: string, facet: string): void {
  rmSync(join(space, agentHome(facet)), { recursive: true, force: true });
}

/** Where paths land, and the runtime's own home. */
function runtimePlanes(cwd: string, space: string, facet: string | undefined, views: readonly VfsMount[]) {
  const home = join(space, agentHome(facet ?? MAIN_AGENT));

  // A hire's `~` is its own home, the workspace's agent's the user's.
  const planes = localPlanes({ space, folder: cwd, home: facet === undefined ? homedir() : home, views: views.map((view) => view.name) });

  return { home, planes };
}

/** The workspace's SOUL.md: a real file of its own space, which every agent of it edits and the shell reads. */
function soulFile(space: string): string {
  return join(space, agentHome(MAIN_AGENT), SOUL_PATH);
}

/** SOUL.md as the workspace's agents left it; null when absent, blank, or a link (as `readSoul` reads it). */
export function soulIn(space: string): string | null {
  if (lstatSync(soulFile(space), { throwIfNoEntry: false })?.isFile() !== true) return null;
  const text = readFileSync(soulFile(space), 'utf8');

  return text.trim() === '' ? null : text;
}

/** As {@link soulIn}, for the workspace whose database `db` is. */
export function soulOf(db: Database): string | null {
  return settleSync(Effect.map(ownSpaceOf(db), soulIn));
}

/** Where a workspace being born writes its seeds. */
export function workspaceHome(db: Database): ReturnType<typeof agentHomeFiles> {
  return settleSync(Effect.map(ownSpaceOf(db), (space) => agentHomeFiles(space, MAIN_AGENT)));
}

/** The own space, `~/.kinu/<workspace>/`, is where the database is; an in-memory one has none. */
function ownSpaceOf(db: Database): Effect.Effect<string, KinuError> {
  const file = db.filename;

  return file === '' || file === ':memory:'
    ? Effect.fail(new KinuError('bad_input', 'a local workspace keeps its own space beside its database file, and an in-memory database has none'))
    : Effect.succeed(dirname(resolvePath(file)));
}

/**
 * Runtime for one logical actor (branching head or swarm-node seat) over the
 * workspace's one database. Hires are not built here: they need the opener's
 * provider and auth wiring.
 */
export async function buildLocalActorRuntime(
  parent: CLIRuntime,
  bound: Pick<BoundActor, 'reference' | 'handle' | 'stores'>,
  seat: 'head' | 'node',
  writeObserver?: WriteObserver,
): Promise<AgentRuntime> {
  // Carry the host's own handle: `ActorHost` refuses a runtime bound anew, since
  // release must revoke every statement the runtime can make.
  const binding = bindLocalActorReference(parent.actor, bound.reference);
  adoptLocalActorHandle(parent.actor, bound.reference, bound.handle);

  const run = binding.origin === 'swarm';

  if (run && seat === 'node') return localNodeRuntime(parent, bound.handle, bound.stores);

  if (run) {
    const opts: Parameters<typeof buildCLIHeadRuntime>[0] = {
      parentRuntime: parent, actorBinding: binding, actor: bound.handle, stores: bound.stores,
    };

    if (writeObserver) opts.writeObserver = writeObserver;

    return await buildCLIHeadRuntime(opts);
  }

  throw new KinuError('denied', `A ${binding.origin} actor's runtime is not built by this workspace's own session.`);
}


/**
 * Runtime for one local head (a fork). Shares the workspace database, memory and
 * craft store; its own home, router and actor-keyed rows stay private. See open-38
 * for the one-workspace-store constraint.
 */
async function buildCLIHeadRuntime(
  opts: {
    parentRuntime: CLIRuntime; actorBinding: LocalActorBinding;
    /** The handle whoever bound this actor issued; re-binding would keep
     *  authorising statements after release. */
    actor: ActorHandle;
    /** The stores its host bound it with: an actor has one bundle. */
    stores: AgentStores;
    /** Watches writes to the parent workspace so the split can name changed files. */
    writeObserver?: WriteObserver;
  },
): Promise<AgentRuntime> {
  const { parentRuntime: parent } = opts;
  const sql = parent.storage.sql;

  if (opts.actorBinding.origin !== 'swarm') throw new KinuError('denied', 'The head runtime requires a registered head actor.');
  const actor = opts.actor;
  const physicalName = actorHomeName({ origin: opts.actorBinding.origin, name: actor.name, storageKey: actor.storageKey });

  const { stores } = opts;
  const agentStateVfs = parent.agentStateVfs;
  const writeObserver = opts.writeObserver;

  // `vfs://context` is this head's own history, not the parent's.
  const { plane: agentVfs, toolFiles } = actorFilePlane({ source: parent, actor, stores, ...(writeObserver !== undefined && { observer: writeObserver }) });

  // Heard on its own plane, and on its parent's under its own actor.
  const unobserved = writeObserver === undefined ? [] : [
    observeNamespace(agentVfs.composite, writeObserver),
    observeNamespace(parent.plane.composite, writeObserver, (writer) => writer.actor === actor.actorId),
  ];

  // A head runs its own gated, checkpointed host shell over the shared folder.
  const shell = parent.facetShell(physicalName);

  const executionRouter = new DefaultExecutionRouter();

  // The same machine the parent's shell runs on.
  executionRouter.register(hostWorkspaceExecutor({
    vfs: toolFiles, files: agentVfs, home: parent.storage.home, planes: parent.planes,
    craftStore: parent.craftStore, shell, sql, actor,
  }));

  const parentHandle: ParentWorkspaceHandle = {
    exec: (command) => answerParentRpc('', async () => {
      if (!parent.shell) throw new Error('the parent workspace has no shell');

      return parent.shell.exec(command);
    }),
  };

  executionRouter.register(createParentExecutor({
    handle: parentHandle,
    workspaceName: actor.name,
  }));

  const checkpoints = parent.checkpoints;

  const runtimeOptions: Parameters<typeof buildRuntime>[0] = {
    transactionSync: (write) => parent.storage.transactionSync(write),
    // The agent-state plane is shared, so the path alone separates actors'
    // programs; with the default, the parent would execute its head's source.
    scaffoldPath: actorScaffoldPath(opts.actorBinding),
    actor, sql, execRaw: parent.storage.execRaw, vfs: agentVfs, home: parent.storage.home, agentStateVfs,
    toolFiles,
    planes: parent.planes,
    llm: parent.llm, executor: parent.executor, schedule: parent.schedule,
    memory: parent.memory, craftStore: parent.craftStore,
    executionRouter, shell,
  };

  if (checkpoints) runtimeOptions.checkpoints = checkpoints;
  const parentProfile = parent.ensureProfile;
  const parentModelForRoute = parent.modelForRoute;

  if (parentProfile && parentModelForRoute) {
    runtimeOptions.modelLanes = {
      resolveProfile: parentProfile,
      llm: parentModelForRoute,
      ...(parent.attemptOf !== undefined && { attemptOf: parent.attemptOf }),
      refusals: parent.refusals,
    };
  }

  // Under its parent's policy; released, it stops hearing writes.
  return Object.assign(buildRuntime(runtimeOptions), {
    approvalPolicy: parent.approvalPolicy,
    release: () => { for (const unobserve of unobserved) unobserve(); },
  });
}

/** A pipe holds at most one buffer (64KB) of unread output at exit; generous
 *  for the command, short enough that an orphaned grandchild's pipe is ignored. */
const EXITED_COMMAND_DRAIN_MS = 250;

export function createHostShell(cwd: string, source: NodeJS.ProcessEnv = process.env): Shell {
  const env = unsandboxedCommandEnvironment(source, readLaunchDotenv(process.cwd(), source.NODE_ENV));

  return {
    exec(command: string, stdinOrOptions?: string | ShellExecOptions) {
      const { promise, resolve } = Promise.withResolvers<ShellExecResult>();

      const { stdin, signal, output }: ShellExecOptions = v.is(v.string(), stdinOrOptions)
        ? { stdin: stdinOrOptions }
        : stdinOrOptions ?? {};

      const outputId = nanoid(10);
      let settled = false;

      const child = spawn('/bin/sh', ['-lc', command], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        detached: true,
      });

      const stdout = new BoundedOutput(COMMAND_OUTPUT_LIMITS, () => hostOutputSpill(cwd, `shell-${outputId}.stdout.log`));
      const stderr = new BoundedOutput(COMMAND_OUTPUT_LIMITS, () => hostOutputSpill(cwd, `shell-${outputId}.stderr.log`));

      const conclude = (end: ProcessEnd | { readonly error: Error }) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        const out = stdout.finish('stdout');
        const err = stderr.finish('stderr');

        if ('error' in end) {
          resolve({ stdout: out, stderr: end.error.message, exitCode: 1 });

          return;
        }

        const { exitCode, note } = exitStatus(end, signal?.aborted === true);
        resolve({ stdout: out, stderr: note === '' ? err : `${err}${err ? '\n' : ''}${note}`, exitCode });
      };

      const onAbort = () => {
        const pid = child.pid;

        if (!pid) return;
        tolerate(() => process.kill(-pid, 'SIGTERM'), 'esrch');
        setTimeout(() => {
          if (!settled) {
            tolerate(() => process.kill(-pid, 'SIGKILL'), 'esrch');
          }
        }, 1500).unref();
      };

      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        stdout.write(chunk);
        output?.write('stdout', chunk);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr.write(chunk);
        output?.write('stderr', chunk);
      });
      child.on('error', (error) => conclude({ error }));

      // A backgrounded grandchild keeps stdout open, so `close` may never
      // come; `exit` starts a bounded drain instead.
      child.on('close', (code, signalName) => conclude({ code, signalName }));
      child.on('exit', (code, signalName) => {
        setTimeout(() => {
          if (settled) return;
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          conclude({ code, signalName });
        }, EXITED_COMMAND_DRAIN_MS).unref();
      });

      if (stdin) child.stdin.end(stdin);
      else child.stdin.end();

      return promise;
    },
  };
}

interface ProcessEnd {
  readonly code: number | null;
  readonly signalName: NodeJS.Signals | null;
}

interface ExitStatus {
  readonly exitCode: number;
  readonly note: string;
}

function exitStatus(end: ProcessEnd, aborted: boolean): ExitStatus {
  if (aborted) return { exitCode: end.code ?? 130, note: 'Command aborted.' };

  if (end.signalName !== null) {
    return { exitCode: 128 + osConstants.signals[end.signalName], note: `Command terminated by ${end.signalName}.` };
  }

  return end.code === null
    ? { exitCode: 1, note: 'Command ended with neither an exit code nor a signal.' }
    : { exitCode: end.code, note: '' };
}

function hostOutputSpill(cwd: string, name: string): OutputSpill {
  const path = `${SPILL_DIRS.toolOutput}/${name}`;
  let fd: number | null = null;
  let failure: string | null = null;

  const fail = (input: { doing: string; cause: unknown }): void => {
    const error = toKinuError({ ...input, otherwise: 'io' });
    diagnostics.failure('shell.output_spill_failed', error);
    failure = renderCauseChain(error);
  };

  try {
    mkdirSync(join(cwd, SPILL_DIRS.toolOutput), { recursive: true });
    fd = openSync(join(cwd, path), 'w', 0o600);
  } catch (cause) {
    fail({ doing: `opening ${path} for a command's output`, cause });
  }

  return {
    write(chunk) {
      if (fd === null) return;

      try {
        for (let offset = 0; offset < chunk.length;) offset += writeSync(fd, chunk, offset);
      } catch (cause) {
        fail({ doing: `writing a command's output to ${path}`, cause });
        closeSync(fd);
        fd = null;
      }
    },
    close(): SpillOutcome {
      if (fd !== null) closeSync(fd);
      fd = null;

      return failure === null ? { path } : { failure };
    },
  };
}

/** The engine dedupes to one snapshot per turn and skips no-op trees. */
function withCheckpointedShell(shell: Shell, checkpoints: FileCheckpoints, cwd: string): Shell {
  // The named shells' reads pass through: an approval is bound to the state they report.
  return {
    ...shell,
    async exec(command, stdinOrOptions) {
      await checkpoints.ensureCheckpoint(cwd, 'shell exec');

      return shell.exec(command, stdinOrOptions);
    },
  };
}
