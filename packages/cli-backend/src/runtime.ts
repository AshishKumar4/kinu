/**
 * Local CLI runtime factory. Two file planes: agent state always lives in the
 * Nimbus filesystem over SQLite; the workspace plane (`file`, `shell`, `eval`,
 * AGENTS.md) binds to `config.cwd` when set, else shares the in-SQLite tree.
 */

import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type {
  AgentRuntime, ActorHandle, ActorReference, CraftStore as CoreCraftStore, LLM, ModelRouteResolution,
  ResolvedTurnProfile, Shell,
} from '@kinu.run/core';
import type {
  Schedule, Memory, VFS, VfsNativeReads, SqlExec, SqlExecutor, SqlValue, RawSqlExec, WorkspaceSchemaSql,
} from '@kinu.run/core';
import type { DeferredApprovalChannel, RequestShellApproval, ShellApprovalPolicy } from '@kinu.run/core';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import {
  type LLMProviderConfig, type SessionFilePlane, actorScaffoldPath, actorReferenceOf, buildRuntime, agentHome, agentArtifactDirectory, headAgentName, subordinateAgentName, MAIN_AGENT, facetHomeProvisioner, agentAffinityKey,
  observeWrites, type WriteObserver,
  WORKSPACE_IDENTITY_DDL,
  createParentExecutor, createParentWorkspaceVfs,
  type ParentWorkspaceHandle, type ParentRpcWrite, type ParentRpcResult,
  DefaultExecutionRouter, createInlineExecutor,
  withMountTable, standardMounts, readTailWithVfsOps,
  withApprovalGatedShell, holdsGrant,
  initFiberTable, initWorkspaceActorTable, WorkspaceActorDirectory, initActorStateSchema, initAgentConfigTable, initCodemodeStateTable, initScaffoldTables,
  createAgentStores, contextMount, skillsMount,
  resolveRoutingProfile, createRoutedModelLane,
  type AgentStores, type ChildContextResolver,
  type ModelCallSink, type ModelOperationSink, type NodeHomeHost, type NodeWorkspace,
  type WorkspaceActor,
} from '@kinu.run/core';
import {
  createWorkspace as createWorkspaceFilesystem,
  type WorkspaceOptions,
  workspaceGenerationStorage,
  workspaceToolchainCapabilities,
} from '@kinu.run/core/workspace';
import { tolerate, tolerateAsync } from '@kinu.run/core/obs';
import { localNodeRuntime } from './node-runtime';
import type { RuntimePackage } from '@nimbus-sh/core/runtime/runtime-package.js';
import { localFacetHost } from '@nimbus-sh/core/runtime/local-facet-host.js';
import { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import bashRuntime from '@nimbus-sh/runtime-bash';
import cpythonRuntime from '@nimbus-sh/runtime-cpython';
import { MemoryStore } from '@kinu.run/agent-utils';
import { CraftStore as AgentUtilsCraftStore } from '@kinu.run/agent-utils';
import { createSandboxedExecutor } from './executor';
import { createHostCheckpoints } from './checkpoints';
import { hostResourceLimits } from './cgroup-limits';
import { hostToolchainCapabilities, HOST_UNMEASURED_CAPABILITIES } from './host-toolchain';
import { createCwdPlaneVFS } from './host-mount';
import { createSqlFiber, detectOrphanedFibers } from '@kinu.run/core';
import { createBranchSpawner } from './branch-process';
import {
  createLocalModelResolver, createLocalProviderLLM,
  type LocalModelResolver, type LocalProviderCredentials,
} from './model-resolver';
import {
  createLocalProfileAuthority,
  type LocalProfileAuthority, type LocalProfileModelPlane,
} from './profile-authority';
import type { LocalCodexAuthStore } from './codex-auth-store';
import type { FileCheckpoints } from '@kinu.run/core';
import { diagnostics, KinuError, toKinuError } from '@kinu.run/core/obs';
import { adoptLocalActorHandle, localActorDirectory, bindLocalActor, bindLocalActorReference, openLocalRootActor, requireLocalDatabasePath, requireLocalActorWorkspace, type LocalActorConfig, type LocalActorBinding } from './actor-identity';
import * as v from 'valibot';

interface CLIRuntimeOptions {
  dbPath: string;
  /**
   * Physical directory the workspace plane binds to. Absent deliberately does not
   * default to `process.cwd()`: an eval episode would write into the developer's repo.
   */
  cwd?: string | null;
  /** Default endpoint for bare ids; null when nothing derives one. The stored
   *  chat model (actor_config) drives the seams instead. */
  llm: LLMProviderConfig | null;
  agentName?: string;
  providerCredentials?: LocalProviderCredentials;
  codexAuthStore?: LocalCodexAuthStore;
  codexConfigPath?: string;
  /** Shadow-git checkpoints kept per working directory. */
  checkpointKeep?: number;
}

export type CLIRuntimeConfig = CLIRuntimeOptions & LocalActorConfig;

/**
 * The local runtime plus late-bound session channels: model seams are built before
 * any session, but their usage belongs in the session's run-event log.
 */
export interface CLIRuntime extends AgentRuntime {
  filesForActor?: (actor: ActorHandle) => Promise<SessionFilePlane>;
  setApprovalDeferrals?(channel: DeferredApprovalChannel | null): void;
  setModelCallSink?(sink: ModelCallSink | null): void;
  /** Lifecycle sink bound beside {@link setModelCallSink}. */
  setModelOperations?(sink: ModelOperationSink | null): void;
  /** Null when this runtime keeps the in-SQLite plane. See CLIRuntimeConfig.cwd. */
  cwd?: string | null;
  setModelForRoute?(factory: (resolution: ModelRouteResolution) => LLM): void;
  modelForRoute?: (resolution: ModelRouteResolution) => LLM;
  /**
   * Fallback turn-profile authority, so a session-less runtime (`kinu evolve`) still
   * routes. A session refines its inputs rather than installing a second resolver.
   */
  profiles?: LocalProfileAuthority;
  /**
   * Override seam for measurement harnesses (`tests/evals/harness.ts`); `null`
   * withholds resolution so an unrouted lane says so rather than inventing a model.
   */
  setProfileResolver?(resolve: (() => Promise<ResolvedTurnProfile>) | null): void;
  /** The issued operation's profile, or current authority for new work. */
  ensureProfile?: () => Promise<ResolvedTurnProfile>;
  /**
   * What a swarm node's private home needs. Withheld on a physical-directory
   * plane, which has no principal registry. A factory so only a search pays the boot.
   */
  nodeHome?: () => Promise<NodeHomeHost>;
  /** Present exactly where {@link nodeHome} is: a node-owned home is one the origin plane cannot write. */
  nodeRuntime?: (node: NodeWorkspace, actor: ActorHandle, source: AgentRuntime, observer?: WriteObserver) => Promise<AgentRuntime>;
  /** A facet's gated, checkpointed host shell with its own `HOME`/`TMPDIR`; present exactly where `cwd` is. */
  facetShell?: (facet: string) => Shell;
  /** Shared rather than rebuilt per consumer: two instances over one actor are two memos of one truth. */
  stores: AgentStores;
  /**
   * Late-bound: the resolver belongs to the root's ActorHost, built after this
   * runtime. Unset manages and lists nothing.
   */
  setChildContext?(resolver: ChildContextResolver | null): void;
}

export type LocalDb = Database;

type WorkspaceSql = Parameters<typeof createWorkspaceFilesystem>[0]['sql'];

type WorkspaceTransactions = Parameters<typeof createWorkspaceFilesystem>[0]['transactions'];

interface NimbusSqlRow {
  [column: string]: string | number | bigint | null | ArrayBuffer | ArrayBufferView;
}

interface LocalSqlRow {
  [column: string]: string | number | boolean | null | ArrayBuffer | Uint8Array;
}

const sqlBindingSchema = v.union([
  v.string(), v.number(), v.bigint(), v.boolean(), v.null(),
  v.instance(ArrayBuffer), v.instance(Uint8Array),
]);

function bunSqlBinding(input: { value: unknown }): SQLQueryBindings {
  const value = v.parse(sqlBindingSchema, input.value);

  return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

export function makeSql(db: Database): SqlExecutor {
  const sql: SqlExecutor = function <T = unknown>(
    strings: TemplateStringsArray,
    ...values: SqlValue[]
  ): T[] {
    const query = strings.reduce((acc, s, i) => acc + s + (i < values.length ? '?' : ''), '');
    // The filesystem binds BLOBs as ArrayBuffer (Cloudflare DO storage.sql's
    // native type); bun:sqlite only binds TypedArrays, so coerce.
    const bound = values.map((value) => bunSqlBinding({ value }));

    // `all()` for every statement, as DO `storage.sql` does: `UPDATE … RETURNING`
    // is a write that produces rows, so sniffing the verb would return `[]`.
    return db.prepare<T, SQLQueryBindings[]>(query).all(...bound);
  };

  return sql;
}

export function makeExecRaw(db: { exec(sql: string): void }): RawSqlExec {
  return (ddl: string) => db.exec(ddl);
}

/** Session payload reads for inspection: the cwd plane when bound, else the
 *  Nimbus filesystem read as the kernel. */
export function inspectionFiles(db: Database, cwd: string | null): Pick<VFS, 'readFile'> {
  if (cwd !== null) return createCwdPlaneVFS(cwd, undefined);
  const vfs = new SqliteVFS(nimbusSql(db), localTransactions(db)).as(CRED_KERNEL);

  return { readFile: (path, opts) => Promise.resolve(opts?.encoding === undefined ? vfs.readFile(path) : vfs.readFileString(path)) };
}

export function nimbusSql(db: Database): WorkspaceSql {
  const exec: WorkspaceSql['exec'] = (query, ...bindings) => {
    const bound = bindings.map((value) => bunSqlBinding({ value }));
    const stmt = db.prepare<NimbusSqlRow, SQLQueryBindings[]>(query);

    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return stmt.all(...bound);
    stmt.run(...bound);

    return [];
  };

  return { exec };
}

/** `bun:sqlite` transactions; a database without one runs non-atomically, stated rather than pretended. */
export function localTransactions(db: Database): WorkspaceTransactions {
  return {
    storage: {
      transactionSync: <T,>(callback: () => T): T => db.transaction(callback)(),
    },
  };
}

/**
 * Runtimes a local workspace can install. Lives here, not in core: 40 MB of wasm
 * read through `node:fs`, which the deployed Worker can neither bundle nor open.
 * Blobs stay on disk until `python3` or `bash` actually runs.
 */
const WORKSPACE_RUNTIMES: readonly RuntimePackage[] = [bashRuntime, cpythonRuntime];

/** Positional-binding SQL; a Durable Object's `ctx.storage.sql` is this natively. */
export function makeSqlExec(db: Pick<Database, 'prepare'>): SqlExec {
  const exec: SqlExec['exec'] = (query, ...bindings) => {
    const bound = bindings.map((value) => bunSqlBinding({ value }));
    // Eager and `all()` regardless of verb, like `storage.sql.exec`.
    const rows = db.prepare<LocalSqlRow, SQLQueryBindings[]>(query).all(...bound).map(toSqlRow);

    return { toArray: () => rows };
  };

  return { exec };
}

function toSqlRow(row: LocalSqlRow) {
  const output: Record<string, SqlValue> = {};

  for (const [column, value] of Object.entries(row)) {
    output[column] = value instanceof Uint8Array
      ? new Uint8Array(value).buffer
      : value;
  }

  return output;
}

/** All onto one database, so no caller can pair a DDL handle with another file's reads. */
export function makeWorkspaceSchemaSql(db: LocalDb): WorkspaceSchemaSql {
  return { execRaw: makeExecRaw(db), sql: makeSql(db), exec: makeSqlExec(db) };
}

/** The tail reads via the plane's stat + ranged read, which MemoryStore's seam lacks. */
function adaptMemory(store: MemoryStore, vfs: VFS & Pick<VfsNativeReads, 'readRange'>): Memory {
  return {
    write: (path, content) => store.writeFile(path, content),
    append: (path, content) => store.appendToFile(path, content),
    async index(path) {
      const raw = await tolerateAsync(() => vfs.readFile(path, { encoding: 'utf8' }), 'enoent');

      if (raw === undefined) return;
      await store.indexFile(path, raw instanceof Uint8Array ? new TextDecoder().decode(raw) : raw);
    },
    search(query, limit = 10) {
      return Promise.resolve(store.search(query, limit));
    },
    read: (path) => store.readFile(path),
    tail: (path, bytes) => readTailWithVfsOps(vfs, path, bytes),
  };
}

/** The concrete store returns null for a miss; core uses undefined. */
function adaptCraftStore(store: AgentUtilsCraftStore): CoreCraftStore {
  return {
    create(tool) {
      store.create(tool);
    },
    update(name, patch) {
      store.update(name, patch);
    },
    get(name) {
      return store.get(name) ?? undefined;
    },
    delete(name) { store.delete(name); },
    list() { return store.list(); },
    search(query, limit = 10) { return store.search(query, limit); },
  };
}

/** Heads, nodes and branches are named by storage key: roster names are not
 *  unique across expansions. */
function actorFacetName(record: WorkspaceActor): string {
  if (record.kind === 'main') return MAIN_AGENT;

  if (record.kind === 'subordinate') return subordinateAgentName(record.name);

  return headAgentName(record.storageKey);
}

export function createCLIRuntime(
  db: Database,
  config: CLIRuntimeConfig,
): CLIRuntime {
  db.exec('PRAGMA foreign_keys = ON');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  requireLocalDatabasePath(db, config.dbPath);

  initFiberTable(execRaw);

  let actor: ActorHandle;
  let agentId: string;
  let agentName: string;

  if (config.facet !== undefined) {
    if (!config.actorBinding) throw new KinuError('missing', 'A local facet requires its root-issued actor binding.');
    initActorStateSchema(makeWorkspaceSchemaSql(db));
    actor = config.actor ?? bindLocalActor(sql, config.actorBinding);
    agentId = actor.actorId;
    agentName = config.actorBinding.name;
  } else {
    execRaw(WORKSPACE_IDENTITY_DDL);
    const existing = sql<{ id: string; name: string }>`SELECT id, name FROM workspace_identity LIMIT 1`[0];

    if (existing) {
      agentId = existing.id;
      agentName = existing.name;
    } else {
      agentId = crypto.randomUUID();
      agentName = config.agentName ?? 'agent';
      void sql`INSERT INTO workspace_identity (id, name) VALUES (${agentId}, ${agentName})`;
      initWorkspaceActorTable(execRaw);
      new WorkspaceActorDirectory(sql, { workspaceId: agentId, ownerUserId: '' }).createMain({ name: agentName });
    }

    actor = openLocalRootActor(db, sql);
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
  initCodemodeStateTable(execRaw);
  initScaffoldTables(execRaw);
  const agentConfig = actor.config;
  // Same endpoint and credentials as the routed-lane factory, so a tier's model is spelled one way.
  let specResolver: LocalModelResolver | null = null;

  const profilePlane: LocalProfileModelPlane = {
    normalizeSpec: (spec) => {
      specResolver ??= createLocalModelResolver({
        llm: config.llm,
        credentials: config.providerCredentials,
        codexAuthStore: config.codexAuthStore,
      });

      return specResolver.normalizeSpecSync(spec);
    },
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

  let modelRouteFactory = (resolution: ModelRouteResolution): LLM => createLocalProviderLLM({
    llm: config.llm,
    sessionAffinity: agentAffinityKey(actor.name),
    credentials: config.providerCredentials,
    codexAuthStore: config.codexAuthStore,
    spec: resolution.model,
    spend: { source: resolution.source, report, operations },
  });

  const modelForRoute = (resolution: ModelRouteResolution): LLM =>
    modelRouteFactory(resolution);

  const modelLanes = {
    resolveProfile: ensureProfile,
    llm: modelForRoute,
  };

  const llm = createRoutedModelLane(actor, 'reflection', modelLanes);

  const schedule: Schedule = {
    // Unreferenced so a one-shot `kinu` command still exits with a timer pending.
    after: async (ms, fn) => {
      // No caller remains when this runs; a rejection is recorded as a domain failure.
      const deferred = async (): Promise<void> => {
        try {
          await fn();
        } catch (cause) {
          diagnostics.failure('schedule.deferred_failed', toKinuError({
            doing: 'running work this session deferred', cause, otherwise: 'io',
          }));
        }
      };

      const timer = setTimeout(deferred, Math.max(0, ms));
      timer.unref?.();
    },
    cron: async () => {},
    fiber: createSqlFiber(sql, actor),
  };

  // `:memory:` is SQLite's in-memory sentinel, not a path.
  const rootDbPath = config.dbPath === ':memory:' ? null : config.dbPath;

  const { spawn: spawnBranch, abort: abortBranch } = createBranchSpawner(rootDbPath, {
    parent: actor, llm: config.llm,
    providerCredentials: config.providerCredentials,
    codexConfigPath: config.codexConfigPath,
  });

  const workspaceSql = nimbusSql(db);

  const workspace = createWorkspaceFilesystem({
    sql: workspaceSql,
    transactions: localTransactions(db),
    generation: workspaceGenerationStorage(workspaceSql),
    runtimes: WORKSPACE_RUNTIMES,
    runtimeFacets: localFacetHost(),
  } satisfies WorkspaceOptions);

  const agentStateVfs = workspace.vfs;
  const checkpoints = createHostCheckpoints({ agent: agentName, keep: config.checkpointKeep });
  const cwd = config.cwd ? resolvePath(config.cwd) : null;
  const fileVfs = cwd ? createCwdPlaneVFS(cwd, checkpoints) : agentStateVfs;

  const memoryStore = new MemoryStore(agentStateVfs, sql);
  memoryStore.ensureSchema();
  const memory = adaptMemory(memoryStore, agentStateVfs);

  const craftStoreImpl = new AgentUtilsCraftStore(sql);
  craftStoreImpl.ensureSchema();
  const craftStore = adaptCraftStore(craftStoreImpl);
  let approvalChannel: RequestShellApproval | null = null;
  let approvalDeferrals: DeferredApprovalChannel | null = null;
  let turnFileLedgerProvider: Parameters<NonNullable<AgentRuntime['setTurnFileLedgerProvider']>>[0] = null;

  const approvalPolicy: ShellApprovalPolicy = {
    mode: () => agentConfig.getShellApprovalMode(),
    granted: (grant) => holdsGrant(agentConfig.getShellApprovalGrants(), grant),
    requestApproval: (request) => approvalChannel?.(request) ?? Promise.resolve(null),
    get deferrals() { return approvalDeferrals ?? undefined; },
  };

  // A directory-bound shell may mutate the tree, so it snapshots first; the
  // in-SQLite shell touches no host file.
  const facetShell = cwd === null ? null : (facet: string | undefined): Shell => withApprovalGatedShell(
    withCheckpointedShell(
      createHostShell(cwd, facet === undefined ? process.env : facetShellEnv(cwd, facet)),
      checkpoints,
      cwd,
    ),
    approvalPolicy,
  );

  const shell: Shell = facetShell
    ? facetShell(config.facet)
    : withApprovalGatedShell(workspace.shell, approvalPolicy);

  const executionRouter = new DefaultExecutionRouter(approvalPolicy);

  const filesForActor = async (target: ActorHandle): Promise<SessionFilePlane> => {
    const record = localActorDirectory(actor).directory.describe(target);
    adoptLocalActorHandle(actor, actorReferenceOf(target), target);
    requireLocalActorWorkspace(actor, target);

    if (cwd !== null) {
      const home = target.actorId === actor.actorId ? cwd : join(cwd, '.kinu', 'actors', target.actorId);
      const artifactDirectory = agentArtifactDirectory(home);
      mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
      chmodSync(artifactDirectory, 0o700);
      target.assertCurrent();

      return { vfs: fileVfs, artifactDirectory };
    }

    const home = await facetHomeProvisioner((async () => ({ ...await workspace.privileged(), sql: workspaceSql }))(), () => target.assertCurrent())(actorFacetName(record));

    if (home.isolation !== 'private-home') throw new KinuError('io', 'actor home provisioner returned a shared plane');
    const plane = await workspace.asAgent(home);
    target.assertCurrent();

    return { vfs: plane.vfs, artifactDirectory: agentArtifactDirectory(home.home) };
  };

  const stores = createAgentStores(() => sql, () => actor, (write) => db.transaction(write)(), () => filesForActor(actor));
  let childContext: ChildContextResolver | null = null;

  const agentVfs = withMountTable(fileVfs, [
    ...standardMounts((name) => executionRouter.getProvider(name)),
    skillsMount((): VFS => agentVfs),
    // `/context`: this actor's own working history, keyed on its own id.
    contextMount({
      stores: () => ({ actorId: actor.actorId, claims: stores.claims, events: stores.eventRecorder }),
      children: {
        list: () => childContext?.list() ?? [],
        resolve: (storageKey) => childContext?.resolve(storageKey) ?? null,
      },
    }),
  ]);

  const limits = hostResourceLimits();

  const inlineOptions: Parameters<typeof createInlineExecutor>[0] = {
    vfs: agentVfs,
    memory,
    craftStore,
    shell,
    sql,
    ledger: () => turnFileLedgerProvider?.(),
    // A directory-bound shell declares what this machine's PATH proves.
    toolchain: cwd === null ? workspaceToolchainCapabilities(WORKSPACE_RUNTIMES) : hostToolchainCapabilities(),
  };

  if (cwd !== null) inlineOptions.unmeasured = HOST_UNMEASURED_CAPABILITIES;

  if (limits) inlineOptions.resourceLimits = limits;
  executionRouter.register(createInlineExecutor(inlineOptions));

  const runtime: CLIRuntime = Object.assign(buildRuntime({
    transactionSync: write => db.transaction(write)(),
    actor, sql,
    execRaw,
    vfs: agentVfs,
    agentStateVfs,
    llm,
    executor: createSandboxedExecutor(),
    schedule,
    memory,
    craftStore,
    modelLanes,
    spawnBranch,
    abortBranch,
    executionRouter, shell, checkpoints,
    setShellApprovalChannel: (fn) => { approvalChannel = fn; },
    setTurnFileLedgerProvider: (provider) => { turnFileLedgerProvider = provider; },
  }), {
    stores,
    filesForActor,
    setApprovalDeferrals: (channel: DeferredApprovalChannel | null) => { approvalDeferrals = channel; },
    setChildContext: (resolver: ChildContextResolver | null) => { childContext = resolver; },
    cwd,
    setModelCallSink: (sink: ModelCallSink | null) => { modelCallSink = sink; },
    setModelOperations: (sink: ModelOperationSink | null) => { modelOperations = sink; },
    profiles,
    modelForRoute,
    setModelForRoute: (factory: (resolution: ModelRouteResolution) => LLM) => {
      modelRouteFactory = factory;
    },
    setProfileResolver: (resolve: (() => Promise<ResolvedTurnProfile>) | null) => {
      profileResolver = resolve;
    },
    ensureProfile,
  });

  // A physical directory has no principal registry, so the node home is withheld
  // and nodes report `shared-origin-plane`.
  if (facetShell) {
    runtime.facetShell = facetShell;
  } else {
    runtime.nodeHome = async () => ({ ...await workspace.privileged(), sql: workspaceSql });
  }

  runtime.nodeRuntime = localNodeRuntime({
    workspace, origin: runtime, approvalPolicy, inline: inlineOptions,
  });

  return runtime;
}

/**
 * Join one facet to its parent's workspace plane. A physical directory needs no
 * joining beyond shared checkpoints; the in-SQLite plane gets the child its own
 * uid-credentialed home in the one tree, as a swarm node does.
 */
export async function shareLocalWorkspacePlane(actor: CLIRuntime, workspace: CLIRuntime, facet: string): Promise<CLIRuntime> {
  requireLocalActorWorkspace(workspace.actor, actor.actor);

  if (workspace.cwd && actor.cwd === workspace.cwd) {
    return Object.assign(actor, { checkpoints: workspace.checkpoints, nodeHome: workspace.nodeHome, nodeRuntime: workspace.nodeRuntime, facetShell: workspace.facetShell });
  }

  if (!workspace.nodeHome || !workspace.nodeRuntime) throw new KinuError('missing', 'The workspace has no actor file-plane owner.');
  const home = await facetHomeProvisioner(workspace.nodeHome(), () => requireLocalActorWorkspace(workspace.actor, actor.actor))(facet);
  const plane = await workspace.nodeRuntime(home, actor.actor, actor);

  return Object.assign(actor, {
    storage: { ...actor.storage, vfs: plane.storage.vfs }, memory: workspace.memory, craftStore: workspace.craftStore,
    executionRouter: plane.executionRouter, shell: plane.shell, checkpoints: workspace.checkpoints, cwd: workspace.cwd ?? null,
    nodeHome: workspace.nodeHome, nodeRuntime: workspace.nodeRuntime, facetShell: workspace.facetShell,
  });
}

/**
 * One facet's `HOME`/`TMPDIR` scratch in a directory-bound workspace. No uid
 * separation exists there, so isolation stays `shared-origin-plane`. The name is
 * validated so `/` or `..` cannot reach the join.
 */
function facetScratchRoot(cwd: string, facet: string): string {
  agentHome(facet);

  return join(cwd, '.kinu', 'facets', facet);
}

function facetShellEnv(cwd: string, facet: string): NodeJS.ProcessEnv {
  const home = facetScratchRoot(cwd, facet);
  const tmp = join(home, 'tmp');
  mkdirSync(tmp, { recursive: true });

  return { ...process.env, HOME: home, TMPDIR: tmp };
}

/** Remove one facet's scratch root, and only that root. */
export function cleanupFacetCwdScratch(cwd: string, facet: string): void {
  rmSync(facetScratchRoot(cwd, facet), { recursive: true, force: true });
}

/**
 * Runtime for one logical actor (branching head or swarm-node seat) over the
 * workspace's one database. Hires are not built here: they need the opener's
 * provider and auth wiring.
 */
export async function buildLocalActorRuntime(
  parent: CLIRuntime,
  bound: { readonly reference: ActorReference; readonly handle: ActorHandle },
  writeObserver?: WriteObserver,
  swarmSeat?: boolean,
): Promise<AgentRuntime> {
  // Carry the host's own handle: `ActorHost` refuses a runtime bound anew, since
  // release must revoke every statement the runtime can make.
  const binding = bindLocalActorReference(parent.actor, bound.reference);
  adoptLocalActorHandle(parent.actor, bound.reference, bound.handle);

  if (binding.kind === 'head' && swarmSeat === true) {
    if (!parent.nodeRuntime) throw new KinuError('missing', 'This workspace has no actor file-plane owner for a node.');

    return await parent.nodeRuntime(
      { isolation: 'shared-origin-plane', home: '.', tmp: undefined, cred: undefined },
      bound.handle, parent, writeObserver,
    );
  }

  if (binding.kind === 'head') {
    const opts: Parameters<typeof buildCLIHeadRuntime>[0] = {
      parentRuntime: parent, actorBinding: binding, actor: bound.handle,
    };

    if (writeObserver) opts.writeObserver = writeObserver;

    return await buildCLIHeadRuntime(opts);
  }

  throw new KinuError('denied', `A ${binding.kind} actor's runtime is not built by this workspace's own session.`);
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
    /** Watches writes to the parent workspace so the split can name changed files. */
    writeObserver?: WriteObserver;
  },
): Promise<AgentRuntime> {
  const { parentRuntime: parent } = opts;
  const sql = parent.storage.sql;

  if (opts.actorBinding.kind !== 'head') throw new KinuError('denied', 'The head runtime requires a registered head actor.');
  const actor = opts.actor;
  const physicalName = headAgentName(actor.storageKey);

  const stores = createAgentStores(() => sql, () => actor, (write) => parent.storage.transactionSync(write), async () => {
    if (!parent.filesForActor) throw new KinuError('missing', 'workspace has no actor file-plane resolver');

    return parent.filesForActor(actor);
  });

  const agentStateVfs = parent.agentStateVfs ?? parent.storage.vfs;
  const cwdPlane = parent.cwd ? createCwdPlaneVFS(parent.cwd, parent.checkpoints) : null;

  const writeObserver = opts.writeObserver;

  const vfs = cwdPlane !== null && writeObserver !== undefined
    ? observeWrites(cwdPlane, writeObserver)
    : cwdPlane ?? agentStateVfs;

  // A head over a shared directory runs the parent's gated, checkpointed shell.
  const parentShell = parent.shell;

  if (!parentShell) throw new KinuError('missing', 'The forked workspace has no shell for its head to run in.');

  const shell = parent.cwd && parent.facetShell
    ? parent.facetShell(physicalName)
    : parentShell;

  const executionRouter = new DefaultExecutionRouter();

  const inlineOptions: Parameters<typeof createInlineExecutor>[0] = {
    vfs, memory: parent.memory, craftStore: parent.craftStore, shell, sql,
    toolchain: workspaceToolchainCapabilities(WORKSPACE_RUNTIMES),
  };

  executionRouter.register(createInlineExecutor(inlineOptions));

  const parentVfs = parent.storage.vfs;
  const ok = <T>(value: T): ParentRpcResult<T> => ({ ok: true, value });

  const fail = <T>(input: { path: string; error: unknown }): ParentRpcResult<T> => {
    const parsed = v.safeParse(v.object({ code: v.optional(v.string()) }), input.error);

    return {
      ok: false,
      error: {
        code: parsed.success && parsed.output.code === 'ENOENT' ? 'ENOENT' : 'EIO',
        message: input.error instanceof Error ? input.error.message : String(input.error),
        path: input.path,
      },
    };
  };

  const attempt = async <T>(path: string, fn: () => Promise<T>): Promise<ParentRpcResult<T>> => {
    try { return ok(await fn()); } catch (error) { return fail<T>({ path, error }); }
  };

  const parentHandle: ParentWorkspaceHandle = {
    read: (path) => attempt(path, async () => {
      const content = await parentVfs.readFile(path);

      return content instanceof Uint8Array ? content : new TextEncoder().encode(content);
    }),
    write: (input: ParentRpcWrite) => attempt(input.path, async () => {
      if (input.kind === 'file') await parentVfs.writeFile(input.path, input.data);
      else await parentVfs.mkdir(input.path, { recursive: input.recursive });

      return null;
    }),
    list: (path) => attempt(path, () => parentVfs.readdir(path)),
    stat: (path) => attempt(path, () => parentVfs.stat(path)),
    delete: (path) => attempt(path, async () => {
      await parentVfs.unlink(path);

      return null;
    }),
    exec: (command) => attempt('', async () => {
      if (!parent.shell) throw new Error('the parent workspace has no shell');

      return parent.shell.exec(command);
    }),
  };

  const parentFiles = createParentWorkspaceVfs(parentHandle);
  executionRouter.register(createParentExecutor({
    handle: parentHandle,
    vfs: opts.writeObserver ? observeWrites(parentFiles, opts.writeObserver) : parentFiles,
    workspaceName: actor.name,
  }));

  // `/context` is this head's own history, not the parent's.
  const agentVfs = withMountTable(vfs, [
    ...standardMounts((name) => executionRouter.getProvider(name)),
    skillsMount((): VFS => agentVfs),
    contextMount({
      stores: () => ({ actorId: actor.actorId, claims: stores.claims, events: stores.eventRecorder }),
    }),
  ]);

  const checkpoints = parent.checkpoints;

  const runtimeOptions: Parameters<typeof buildRuntime>[0] = {
    transactionSync: (write) => parent.storage.transactionSync(write),
    // The agent-state plane is shared, so the path alone separates actors'
    // programs; with the default, the parent would execute its head's source.
    scaffoldPath: actorScaffoldPath(opts.actorBinding),
    actor, sql, execRaw: parent.storage.execRaw, vfs: agentVfs, agentStateVfs,
    llm: parent.llm, executor: parent.executor, schedule: parent.schedule,
    memory: parent.memory, craftStore: parent.craftStore,
    spawnBranch: parent.spawnBranch, abortBranch: parent.abortBranch,
    executionRouter, shell,
  };

  if (checkpoints) runtimeOptions.checkpoints = checkpoints;
  const parentProfile = parent.ensureProfile;
  const parentModelForRoute = parent.modelForRoute;

  if (parentProfile && parentModelForRoute) {
    runtimeOptions.modelLanes = {
      resolveProfile: parentProfile,
      llm: parentModelForRoute,
    };
  }

  const runtime = buildRuntime(runtimeOptions);

  if (parent.cwd) return runtime;

  if (!parent.nodeHome || !parent.nodeRuntime) throw new KinuError('missing', 'The head has no canonical workspace file-plane owner.');
  const home = await facetHomeProvisioner(parent.nodeHome(), () => requireLocalActorWorkspace(parent.actor, actor))(physicalName);

  return parent.nodeRuntime(home, actor, runtime, opts.writeObserver);
}

/** A pipe holds at most one buffer (64KB) of unread output at exit; generous
 *  for the command, short enough that an orphaned grandchild's pipe is ignored. */
const EXITED_COMMAND_DRAIN_MS = 250;

const shellOptionsSchema = v.object({
  stdin: v.optional(v.string()),
  signal: v.optional(v.instance(AbortSignal)),
});


export function createHostShell(cwd: string, env: NodeJS.ProcessEnv = process.env): Shell {
  return {
    exec(command: string, stdinOrOptions?: string | { stdin?: string; signal?: AbortSignal }) {
      return new Promise((resolve) => {
        const stdinText = v.safeParse(v.string(), stdinOrOptions);
        const options = v.safeParse(shellOptionsSchema, stdinOrOptions);
        const optionsStdin = options.success ? options.output.stdin : undefined;
        const stdin = stdinText.success ? stdinText.output : optionsStdin;
        const signal = options.success ? options.output.signal : undefined;
        let settled = false;

        const child = spawn('/bin/sh', ['-lc', command], {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
          detached: true,
        });

        let stdout = '';
        let stderr = '';

        const finish = (result: { stdout: string; stderr: string; exitCode: number }) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          resolve(result);
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
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (err) => finish({ stdout, stderr: err.message, exitCode: 1 }));

        const settle = (code: number | null, signalName: NodeJS.Signals | null) => {
          const aborted = (signal?.aborted ?? false) || signalName === 'SIGTERM' || signalName === 'SIGKILL';
          finish({
            stdout,
            stderr: aborted ? `${stderr}${stderr ? '\n' : ''}Command aborted.` : stderr,
            exitCode: code ?? (aborted ? 130 : 0),
          });
        };

        // A backgrounded grandchild keeps stdout open, so `close` may never
        // come; `exit` starts a bounded drain instead.
        child.on('close', settle);
        child.on('exit', (code, signalName) => {
          setTimeout(() => {
            if (settled) return;
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref();
            settle(code, signalName);
          }, EXITED_COMMAND_DRAIN_MS).unref();
        });

        if (stdin) child.stdin.end(stdin);
        else child.stdin.end();
      });
    },
  };
}

/** The engine dedupes to one snapshot per turn and skips no-op trees. */
function withCheckpointedShell(shell: Shell, checkpoints: FileCheckpoints, cwd: string): Shell {
  return {
    async exec(command, stdinOrOptions) {
      await checkpoints.ensureCheckpoint(cwd, 'shell exec');

      return shell.exec(command, stdinOrOptions);
    },
  };
}
