/**
 * Linux CLI runtime factory — bun:sqlite, agent-utils for FTS5 memory search,
 * and the same primitives cf-backend implements, bridged by adapter wrappers.
 *
 * A local runtime has TWO file planes and the difference is the whole design.
 * The agent's own state — SOUL.md, its scaffold, memory, transcripts — lives in
 * the Nimbus filesystem over its own SQLite, always. The WORKSPACE plane, which
 * is what `file`, `run`, `execute_tools` and AGENTS.md address, binds to a
 * physical directory when `config.cwd` names one, and every agent bound to that
 * directory is working on the same bytes. With no directory bound both planes
 * are the one in-SQLite tree, which is what an isolated fixture or an eval
 * episode gets.
 */

import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type {
  AgentRuntime, ActorHandle, ActorReference, CraftStore as CoreCraftStore, LLM, ModelRouteResolution,
  ResolvedTurnProfile, Shell,
} from '@kinu.run/core';
import type {
  Schedule, Memory, VFS, VfsNativeReads, SqlExec, SqlExecutor, SqlValue, RawSqlExec, WorkspaceSchemaSql,
} from '@kinu.run/core';
import type { ExecutorProvider, ResourceLimits } from '@kinu.run/core';
import type { RequestShellApproval, ShellApprovalPolicy } from '@kinu.run/core';
import { spawn } from 'node:child_process';
import { promises as fs, mkdirSync, rmSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import {
  type LLMProviderConfig, actorScaffoldPath, buildRuntime, agentHome, headAgentName, facetHomeProvisioner,
  observeWrites, type WriteObserver,
  WORKSPACE_IDENTITY_DDL,
  createParentExecutor, createParentWorkspaceVfs,
  type ParentWorkspaceHandle, type ParentRpcWrite, type ParentRpcResult,
  DefaultExecutionRouter, createInlineExecutor, commandResult, COMMAND_RESULT_TYPE,
  withMountTable, standardMounts, readTailWithVfsOps,
  withApprovalGatedShell,
  initFiberTable, initWorkspaceActorTable, WorkspaceActorDirectory, initActorStateSchema, initAgentConfigTable, initCodemodeStateTable, initScaffoldTables,
  createAgentStores, contextMount,
  resolveModelRoute,
  type AgentStores, type ChildContextResolver,
  type ModelCallSink, type ModelOperationSink, type NodeHomeHost, type NodeWorkspace,
} from '@kinu.run/core';
import {
  createWorkspace as createWorkspaceFilesystem,
  type WorkspaceOptions,
  nextWorkspaceGeneration,
  workspaceToolchainCapabilities,
} from '@kinu.run/core/workspace';
import { tolerate, tolerateAsync } from '@kinu.run/core/obs';
import { localNodeRuntime } from './node-runtime';
import type { RuntimePackage } from '@nimbus-sh/core/runtime/runtime-package.js';
import { localFacetHost } from '@nimbus-sh/core/runtime/local-facet-host.js';
import bashRuntime from '@nimbus-sh/runtime-bash';
import cpythonRuntime from '@nimbus-sh/runtime-cpython';
import { MemoryStore } from '@kinu.run/agent-utils';
import { CraftStore as AgentUtilsCraftStore } from '@kinu.run/agent-utils';
import { createSandboxedExecutor } from './executor';
import { createHostCheckpoints } from './checkpoints';
import { hostResourceLimits } from './cgroup-limits';
import { hostToolchainCapabilities, HOST_UNMEASURED_CAPABILITIES } from './host-toolchain';
import { createCwdPlaneVFS, createHostMountVFS } from './host-mount';
import { createLinuxFiber, detectOrphanedFibers } from './fiber';
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
import { diagnostics, KinuError } from '@kinu.run/core/obs';
import { adoptLocalActorHandle, bindLocalActor, bindLocalActorReference, openLocalRootActor, requireLocalDatabasePath, requireLocalActorWorkspace, type LocalActorConfig, type LocalActorBinding } from './actor-identity';
import * as v from 'valibot';

interface CLIRuntimeOptions {
  dbPath: string;
  /**
   * The physical directory this workspace's file and shell plane binds to —
   * the canonical cwd stored on the agent's local ref, never `process.cwd()`.
   *
   * A string binds `file`, `run`, `execute_tools`, AGENTS.md discovery and the
   * workspace shell to that directory, which is what makes every agent sharing
   * it a peer rather than a stranger holding a private copy. Absent keeps the
   * in-SQLite workspace filesystem, and absent deliberately does NOT mean
   * "default to the process's directory": an eval episode handed an implicit
   * host plane writes into the developer's repo (see `hostRoot`).
   */
  cwd?: string | null;
  /** The workspace's default endpoint for bare ids — null when nothing
   *  derives one. Explicit specs resolve through the registry regardless;
   *  the stored chat model (actor_config) drives the seams instead. */
  llm: LLMProviderConfig | null;
  agentName?: string;
  providerCredentials?: LocalProviderCredentials;
  codexAuthStore?: LocalCodexAuthStore;
  codexConfigPath?: string;
  /**
   * Where the HOST plane is rooted — the `laptop` executor and the checkpointed
   * host shell behind it, i.e. the developer's own filesystem. Defaults to the
   * bound `cwd`, or to `process.cwd()` when nothing is bound: `/pc` and the
   * agent's own workspace then name one directory rather than two.
   *
   * `null` withholds the plane entirely, and that is the only isolation there
   * is: `laptop.writeFile` resolves an ABSOLUTE path straight through and
   * `laptop.exec` runs a real shell that can `cd` anywhere, so re-rooting the
   * provider somewhere harmless contains nothing. A measurement harness passes
   * `null` — an eval episode with a host plane writes into the developer's repo
   * (tests/evals/harness.ts, `requireSandboxedExecutors`).
   */
  hostRoot?: string | null;
  /** Shadow-git checkpoints kept per working directory (the one retention knob). */
  checkpointKeep?: number;
}

export type CLIRuntimeConfig = CLIRuntimeOptions & LocalActorConfig;

/**
 * The local runtime plus the one channel a session installs after the fact.
 *
 * `rt.llm`, `rt.fastLlm` and `rt.judgeModel` are built by `createCLIRuntime`,
 * before any session exists — but the ledger their usage reports belong in is
 * the SESSION's durable run-event log, the recorder that also forwards every row
 * to the frontends as it is written. So the sink is late-bound, exactly like the
 * shell approval channel and the turn file ledger are.
 *
 * Optional so that a plain `AgentRuntime` still satisfies this type: a surface
 * that hands a session a runtime it did not build here binds nothing, and its
 * non-turn spend is unattributed — which the workspace total's coverage fraction
 * states rather than hides.
 */
export interface CLIRuntime extends AgentRuntime {
  setModelCallSink?(sink: ModelCallSink | null): void;
  /** Where direct model operations record their lifecycle; the session binds
   *  it beside {@link setModelCallSink}. Optional for the same reason. */
  setModelOperations?(sink: ModelOperationSink | null): void;
  /** The physical directory the workspace plane is bound to, or null when this
   *  runtime keeps the in-SQLite plane. See CLIRuntimeConfig.cwd. */
  cwd?: string | null;
  setModelForRoute?(factory: (resolution: ModelRouteResolution) => LLM): void;
  setTurnProfile?(profile: ResolvedTurnProfile): void;
  turnProfile?(): ResolvedTurnProfile | null;
  modelForRoute?(resolution: ModelRouteResolution): LLM;
  /**
   * The turn-profile authority every routed lane resolves through when no turn
   * has installed a profile. Built by {@link createCLIRuntime}, so a runtime
   * opened WITHOUT a session — `kinu evolve`, a fixture, any future
   * session-less surface — still routes its judge, explorer, fast and advisor
   * lanes. A session REFINES its inputs (its own provider plane, its own
   * catalog authority, its own run-event recorder) rather than installing a
   * second resolver, which is how the two came to disagree.
   */
  profiles?: LocalProfileAuthority;
  /**
   * Replace the resolver every routed lane falls back to.
   *
   * No product caller: {@link createCLIRuntime} installs one over
   * {@link profiles} at construction and a session refines that. This stays as
   * the override seam a measurement harness needs — `tests/evals/harness.ts`
   * pins one fixed profile so an episode resolves nothing per turn — and
   * `null` withholds resolution entirely, which is what makes an unrouted lane
   * say so rather than invent a model.
   */
  setProfileResolver?(resolve: (() => Promise<ResolvedTurnProfile>) | null): void;
  /**
   * The profile routed lanes must have. Returns the installed one when a turn
   * is open, else resolves one now and installs it, so durable work that began
   * outside a chat turn — the review lane, the evolution cadence, reflection,
   * the advisor — routes through the same table a turn does instead of finding
   * every lane unset. An already-installed profile is never replaced, so this
   * cannot disturb a running turn.
   */
  ensureProfile?(): Promise<ResolvedTurnProfile>;
  /**
   * The three host-owned things a swarm node's private home needs — the uid-0
   * view of this workspace's filesystem, the principal registry that scopes
   * `/tmp`, and the SQL the uid allocation is a row in. *Isolation*.
   *
   * Present here and nowhere else because this backend's filesystem can be an
   * in-isolate `NimbusWorkspace`: the hosted backend reaches its workspace by RPC
   * to another Durable Object, where every pid-less filesystem call is the session
   * user and `confinePrincipal` has no RPC at all, so there is nothing there to
   * hand over. Withheld here too once the plane is a physical directory, which
   * has no principal registry to confine — see `createCLIRuntime`.
   *
   * A factory returning a promise, because the workspace boots: a turn that never
   * searches must not pay for a boot only a search needs. Optional for the same
   * reason `setModelCallSink` is — a plain `AgentRuntime` still satisfies this
   * type, and then its nodes report `shared-origin-plane`.
   */
  nodeHome?: () => Promise<NodeHomeHost>;
  /**
   * This workspace addressed as one provisioned node, both planes credentialed
   * — `node-runtime.ts`. Present exactly where {@link nodeHome} is, because a
   * home owned by the node is a home the ORIGIN's plane cannot write.
   */
  nodeRuntime?: (node: NodeWorkspace, actor: ActorHandle, source: AgentRuntime, observer?: WriteObserver) => Promise<AgentRuntime>;
  /**
   * A directory-bound workspace's shell for one facet: the same gated,
   * checkpointed host shell, with that facet's own `HOME` and `TMPDIR`. Present
   * exactly where `cwd` is, because a principal registry does the same job on
   * the in-SQLite plane through {@link nodeRuntime}.
   */
  facetShell?: (facet: string) => Shell;
  /**
   * The SQL-derived stores THIS actor has — the one list both backends
   * inherit, built here because a runtime is the first thing that exists for
   * an actor and its own context plane already reads two of them.
   *
   * Shared rather than rebuilt per consumer: the `/context` mount, the
   * session, and the ActorHost's `BoundActor` all mean the same claim ledger
   * and the same run-event recorder, and two instances over one actor is two
   * memos of one truth.
   */
  stores: AgentStores;
  /**
   * Publish the resolver for the actors this one MANAGES, so `/context/agents/`
   * can list them.
   *
   * Late-bound for the same reason the shell-approval channel is: the resolver
   * belongs to the root's ActorHost, and a root's runtime is built before that
   * host exists (`openWorkspaceCLI` opens the database first). A runtime that
   * is never handed one manages nothing and lists nothing, which is the honest
   * answer for `kinu evolve` and for a fixture.
   */
  setChildContext?(resolver: ChildContextResolver | null): void;
}

/** The bun:sqlite surface every local SQL adapter here needs. */
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

    // `all()` for EVERY statement, not only the ones opening with a read verb.
    // A Durable Object's `storage.sql` returns whatever rows a statement
    // produces, and `UPDATE … RETURNING` is a write that produces them — so
    // sniffing the leading keyword answered `[]` while still performing the
    // write, which is how core's two RETURNING sites (the stranded event-delivery
    // reclaim, the deferred shell-approval claim) read as "nothing matched" on
    // this backend only. bun's `all()` executes any statement and returns its
    // rows; DDL and plain writes simply have none.
    return db.prepare<T, SQLQueryBindings[]>(query).all(...bound);
  };

  return sql;
}

export function makeExecRaw(db: { exec(sql: string): void }): RawSqlExec {
  return (ddl: string) => db.exec(ddl);
}

/**
 * The SQL port the workspace filesystem needs — positional bindings, rows
 * returned by iteration. `makeSqlExec` already speaks this shape; Nimbus wants
 * the iterable directly rather than a `toArray` cursor.
 */
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

/**
 * The workspace filesystem's atomicity primitive.
 *
 * `bun:sqlite` exposes `db.transaction(fn)`; a database that does not is run
 * without one, which is stated rather than silently pretended — every atomic
 * write becomes a torn write that reports success.
 */
export function localTransactions(db: Database): WorkspaceTransactions {
  return {
    storage: {
      transactionSync: <T,>(callback: () => T): T => db.transaction(callback)(),
    },
  };
}

/**
 * The runtimes a local workspace can install into itself.
 *
 * Named here rather than in `@kinu.run/core` because these are the bytes: 40 MB
 * of wasm read through `node:fs`, which the deployed Worker can neither bundle
 * nor open. A hosted session gets the same runtimes from R2 through
 * `nimbus install`; this is the same publisher for a host that has a disk.
 *
 * Importing them costs the two manifests. The blobs stay on disk until a
 * `python3` or a `bash` is actually run — see core/vfs/workspace-runtimes.ts.
 */
const WORKSPACE_RUNTIMES: readonly RuntimePackage[] = [bashRuntime, cpythonRuntime];

/** Positional-binding SQL — what the events hub, the release board and
 *  the experience library speak. A Durable Object's `ctx.storage.sql` is this
 *  natively; bun:sqlite is one wrapper away. */
export function makeSqlExec(db: Pick<Database, 'prepare'>): SqlExec {
  const exec: SqlExec['exec'] = (query, ...bindings) => {
    const bound = bindings.map((value) => bunSqlBinding({ value }));
    // Executed here rather than inside `toArray`, and read with `all()`
    // whatever the verb — see makeSql above for why the verb cannot decide it.
    // Eager also matches the seam it stands in for: `storage.sql.exec` runs the
    // statement and hands back a cursor over its rows.
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

/** The three handles core's `initWorkspaceSchema` needs, all onto one local
 *  database — so no caller can pair a DDL handle with another file's reads. */
export function makeWorkspaceSchemaSql(db: LocalDb): WorkspaceSchemaSql {
  return { execRaw: makeExecRaw(db), sql: makeSql(db), exec: makeSqlExec(db) };
}

/**
 * Adapt agent-utils MemoryStore to core Memory interface. The tail reads off
 * the plane's own stat + ranged read, which is why the plane comes alongside
 * the store: MemoryStore's filesystem seam has neither.
 */
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

/**
 * Adapt agent-utils CraftStore to core CraftStore interface.
 * The concrete store returns null for a miss; core uses undefined.
 */
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

export function createCLIRuntime(
  db: Database,
  config: CLIRuntimeConfig,
): CLIRuntime {
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

  // AFTER the branch above, never before it: the sweep reads THIS actor's lanes
  // and there is no actor to read for until one of the two arms has bound one.
  // Every actor in a workspace mints the same fiber names, so an unscoped sweep
  // here would report — and a recovery would resume — a sibling's lane.
  const orphans = detectOrphanedFibers(sql, actor);

  if (orphans.length > 0) {
    diagnostics.failure(
      'fiber.orphans_detected',
      new KinuError('cancelled', 'fibers from a previous run were interrupted by its exit'),
      { orphans: orphans.length },
    );
  }

  // The three model seams below are built here, before a session exists, so each
  // reports through one stable closure over a slot the session fills in
  // (setModelCallSink). Until it does, a report has nowhere to go: an unbound
  // runtime is unattributed spend, never free spend.
  //
  // The SOURCE is stated here rather than inside the factory, because this is
  // the layer that knows which producer each seam is: one factory serves all
  // three, and to it they are the same call.
  let modelCallSink: ModelCallSink | null = null;
  const report: ModelCallSink = (call) => modelCallSink?.(call);
  // The lifecycle half of the same seam: the session binds this alongside the
  // sink above, and until it does an unbound runtime is unattributed
  // in-flight work, never work that never started.
  let modelOperations: ModelOperationSink | null = null;
  const operations: ModelOperationSink = (event) => modelOperations?.(event);
  // Shared by every typed actor_config read this runtime does — at
  // construction, and at exec time for the live shell-approval mode the gate
  // consults on every command. Its DDL runs here because a runtime built
  // WITHOUT `initWorkspaceSchema` (a branch worker, `kinu evolve`, a fixture)
  // still reads the table on its first gated command.
  initAgentConfigTable(execRaw);
  initCodemodeStateTable(execRaw);
  // Same reason the agent-config DDL runs here: a runtime built without
  // `initWorkspaceSchema` (a branch worker, `kinu evolve`, a fixture) still
  // reads and writes scaffold tables on its first identity.scaffold touch.
  initScaffoldTables(execRaw);
  const agentConfig = actor.config;
  let turnProfile: ResolvedTurnProfile | null = null;
  // The model plane a PROFILE resolves against: how a stored spec is spelled in
  // full, and what the account can reach. Built from the same endpoint and
  // credentials the routed-lane factory below uses, so a tier's model and the
  // model that lane runs cannot be spelled two different ways. Lazy because a
  // registry costs a construction and a runtime that never resolves a profile
  // never needs one.
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
    // Nothing beyond the configured model, which the snapshot folds in itself.
    // This plane never asked a provider what it carries, so it claims nothing
    // it did not look up — and a session that CAN list refines it.
    listModels: () => Promise.resolve({ models: [], failures: [] }),
  };

  const profiles = createLocalProfileAuthority({ config: agentConfig, plane: profilePlane });

  // THE installation. Every local runtime is born here, so every local runtime
  // routes — a session-less one included. Without this line `kinu evolve`
  // spends a whole search against lanes that throw for want of a resolver.
  let profileResolver: (() => Promise<ResolvedTurnProfile>) | null =
    () => profiles.resolvePreTurn();

  /**
   * The profile a routed lane runs against. A turn's own resolution wins; with
   * no turn open the live resolver supplies one and it is installed, so the
   * next lane in the same pass does not resolve it again. The `??=` is the race
   * guard: a turn that landed while this awaited keeps its own profile, because
   * a turn's profile is immutable for the length of the turn.
   */
  const ensureProfile = async (): Promise<ResolvedTurnProfile> => {
    if (turnProfile) return turnProfile;

    if (!profileResolver) {
      throw new Error('this runtime has no profile resolver: model lanes cannot route before a turn');
    }

    const resolved = await profileResolver();
    turnProfile ??= resolved;

    return turnProfile;
  };

  let modelRouteFactory = (resolution: ModelRouteResolution): LLM => createLocalProviderLLM({
    llm: config.llm,
    credentials: config.providerCredentials,
    codexAuthStore: config.codexAuthStore,
    spec: resolution.model,
    spend: { source: resolution.source, report, operations },
  });

  const modelForRoute = (resolution: ModelRouteResolution): LLM =>
    modelRouteFactory(resolution);

  const llm: LLM = {
    async *stream() { yield ""; },
    async complete(prompt: string): Promise<string> {
      const resolution = resolveModelRoute('reflection', await ensureProfile());

      if (!resolution) throw new Error('reflection cannot use the fixed platform model route');

      return modelForRoute(resolution).complete(prompt);
    },
  };

  const modelLanes = {
    turnProfile: () => turnProfile,
    llm: modelForRoute,
  };


  const schedule: Schedule = {
    after: async (_ms, fn) => { setTimeout(fn, 0); },
    cron: async () => {},
    fiber: createLinuxFiber(sql, actor),
  };

  // `:memory:` is SQLite's in-memory sentinel, not a path — see the spawner's
  // own doc comment. Null tells it there is no file rather than letting it
  // point a second OS process at a handle nothing outside this one can open.
  const rootDbPath = config.dbPath === ':memory:' ? null : config.dbPath;

  const { spawn: spawnBranch, abort: abortBranch } = createBranchSpawner(rootDbPath, {
    parent: actor, llm: config.llm,
    providerCredentials: config.providerCredentials,
    codexConfigPath: config.codexConfigPath,
  });

  // The agent's own state stays in its SQLite-backed filesystem: SOUL.md, the
  // scaffold, memory, transcripts. What binds to a physical directory is the
  // WORKSPACE plane — the files and the shell a turn works in — and that is
  // what makes two agents in one directory peers rather than strangers.
  const workspaceSql = nimbusSql(db);

  const workspace = createWorkspaceFilesystem({
    sql: workspaceSql,
    transactions: localTransactions(db),
    generation: nextWorkspaceGeneration(workspaceSql),
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
  let turnFileLedgerProvider: Parameters<NonNullable<AgentRuntime['setTurnFileLedgerProvider']>>[0] = null;

  const approvalPolicy: ShellApprovalPolicy = {
    mode: () => agentConfig.getShellApprovalMode(),
    granted: (grant) => agentConfig.getShellApprovalGrants()
      .some((candidate) => candidate.rule === grant.rule && candidate.executor === grant.executor),
    requestApproval: (request) => approvalChannel?.(request) ?? Promise.resolve(null),
  };

  // Bound to a directory, the workspace runtime IS the host shell there, and
  // any command may mutate the tree, so it snapshots first. The in-SQLite
  // shell touches no host file and names no host directory, so checkpointing
  // it asked the shadow-git engine to snapshot the database file.
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
  const stores = createAgentStores(() => sql, () => actor, (write) => db.transaction(write)());
  let childContext: ChildContextResolver | null = null;

  const agentVfs = withMountTable(fileVfs, [
    ...standardMounts((name) => executionRouter.getProvider(name)),
    // `/context` — this actor's own working history, read live off the two
    // stores above. Every actor in this database gets its own, keyed on its own
    // id, so a subordinate reading `/context` reads its own turns and never the
    // root's.
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
    toolchain: workspaceToolchainCapabilities(WORKSPACE_RUNTIMES),
  };

  if (limits) inlineOptions.resourceLimits = limits;
  executionRouter.register(createInlineExecutor(inlineOptions));

  const hostRoot = config.hostRoot === undefined ? cwd ?? process.cwd() : config.hostRoot;

  // Held, because a node's router registers this SAME provider: the host
  // filesystem is the host filesystem whoever asks, and a second construction
  // would be a second set of checkpoints over one directory.
  const laptop = hostRoot === null
    ? null
    : createLocalLaptopExecutor(
      hostRoot,
      withCheckpointedShell(createHostShell(hostRoot), checkpoints, hostRoot),
      checkpoints,
      limits,
    );

  if (laptop) executionRouter.register(laptop);

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
    setChildContext: (resolver: ChildContextResolver | null) => { childContext = resolver; },
    cwd,
    setModelCallSink: (sink: ModelCallSink | null) => { modelCallSink = sink; },
    setModelOperations: (sink: ModelOperationSink | null) => { modelOperations = sink; },
    setTurnProfile: (profile: ResolvedTurnProfile) => { turnProfile = profile; },
    turnProfile: () => turnProfile,
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

  // A swarm node's private home is a uid-confined directory INSIDE the plane it
  // writes to: the privileged view and the uid it is chown'ed to are both rows
  // in this database, so the home outlives the activation that made it. A
  // physical directory has neither half — no principal registry to confine, and
  // every node already shares the origin plane by construction — so the host is
  // withheld rather than faked, and a node states `shared-origin-plane` instead
  // of being handed a home in a filesystem its work cannot reach.
  if (facetShell) {
    runtime.facetShell = facetShell;
  } else {
    runtime.nodeHome = async () => ({ ...await workspace.privileged(), sql: workspaceSql });
  }

  runtime.nodeRuntime = localNodeRuntime({
    workspace, origin: runtime, approvalPolicy, inline: inlineOptions, laptop,
  });

  return runtime;
}

/**
 * Join one facet to its parent's workspace plane, keeping its own SQL
 * identity, conversation, scaffold closure and branch state.
 *
 * A physical directory needs no joining. A child opened with its parent's cwd
 * already addresses the same bytes through its OWN executors, with `HOME` and
 * `TMPDIR` in its own scratch, so its memory and craft store stay private —
 * which is the contract — and the one thing genuinely shared per directory is
 * the undo history: two agents editing one tree want one restore point, not two
 * that can each revert the other's work.
 *
 * The in-SQLite plane is per-database, so there a child cannot see its
 * parent's files at all without being moved onto them. It is moved onto them
 * as itself: a home of its own in the one tree, a private `/tmp`, and both
 * planes credentialed as its uid, the way a swarm node is.
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
 * One facet's own scratch inside a directory-bound workspace.
 *
 * A bound directory has no principal registry — every command runs as the
 * same Unix user — so uid/gid/mode cannot separate two facets there, and the
 * tree stays honestly shared: siblings can read it, and the isolation a
 * directory-bound facet reports stays `shared-origin-plane`. What each facet
 * still gets is its own mapped ground: a home directory and a tmp directory
 * under the workspace's own state, created for the facet and removed with
 * it. `HOME` and `TMPDIR` point there; nothing copies the workspace into
 * them, and they are ordinary directories rather than a second workspace —
 * no plane, no shell, no scaffold of their own.
 *
 * The name is validated like a workspace home, because a scratch root is a
 * directory under a fixed parent and a name holding `/` or `..` must not
 * reach the join.
 */
function facetScratchRoot(cwd: string, facet: string): string {
  agentHome(facet);

  return join(cwd, '.kinu', 'facets', facet);
}

/** The process environment a directory-bound facet's commands run in. */
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
 * The runtime for one LOGICAL ACTOR of this workspace, over the ONE database
 * the workspace already has.
 *
 * The seam `ActorHostDeps.runtimeFor` is satisfied by, for the heads a session
 * creates on its own authority: a branching head, and a swarm node's seat —
 * which is a head row with its mode declared in `swarmSeat`. A HIRE is not
 * here, because a subordinate's runtime needs the provider and auth wiring the
 * surface that opened the workspace holds — the agent host supplies that and
 * delegates heads to this function, so both hosts build one head the same way.
 *
 * A node's BASE runtime shares the origin's plane and says so. A search that
 * provisions private homes re-provisions it per node
 * (`AgentsSwarmDeps.runtimeForNodeWorkspace`), which changes the credential its
 * shell and files act as and nothing about which actor it is. The seat's home
 * comes later, through that seam; building the head's own home here as well
 * would provision a plane the loop never runs on.
 */
export async function buildLocalActorRuntime(
  parent: CLIRuntime,
  bound: { readonly reference: ActorReference; readonly handle: ActorHandle },
  writeObserver?: WriteObserver,
  swarmSeat?: boolean,
): Promise<AgentRuntime> {
  // THE HOST'S HANDLE TRAVELS THROUGH, and the whole point of taking `bound`
  // rather than a bare reference is that it cannot be re-derived here: the
  // directory mints a fresh frozen handle on every bind, and `ActorHost`
  // requires the runtime to carry the one IT issued so that releasing the
  // binding revokes every statement the runtime can still make. Re-binding
  // produced a runtime the host refused outright — no head or node could be
  // acquired on this backend at all.
  const binding = bindLocalActorReference(parent.actor, bound.reference);
  // The host's handle needs this root's scope before anything reads local
  // identity through it — same scope, same reference, validated again here.
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
 * The runtime a single local head (a fork of the parent workspace) runs over.
 *
 * ONE DATABASE. A head shares the workspace database, filesystem, memory index
 * and craft store; its scaffold pointer, claims, journal steps and program
 * state are actor-keyed, so the parent can read what its own fork did. See
 * open-38 for the one-workspace-store constraint.
 *
 * What stays private is what makes this a FORK rather than a second view: its
 * own HOME in the one filesystem (`headAgentName`, uid-confined where the
 * plane has a principal registry), its own execution router, and its own
 * actor-keyed rows. Memory and the craft store are the workspace's, which is
 * what a fork of that workspace should read.
 *
 * Where the head's canonical FILES are depends on what the parent is bound to.
 * A parent bound to a physical directory shares it: a fork explores the same
 * project, so the head addresses those bytes directly and `parent.*` reaches
 * the same tree by another name. An in-SQLite parent hands the head its own
 * home in the one global view, credentialed as itself, exactly as a swarm node
 * gets one.
 *
 * The head also inherits the parent's `laptop` provider unchanged, so `run
 * laptop` and `laptop.*` reach the real machine at the parent's cwd — the fork's
 * real execution, and what the doctrine promises a fork.
 */
async function buildCLIHeadRuntime(
  opts: {
    parentRuntime: CLIRuntime; actorBinding: LocalActorBinding;
    /**
     * The handle whoever BOUND this actor issued.
     *
     * `ActorHost` requires a hosted runtime to carry the very handle it issued
     * (`state/actor-host.ts`), because a release revokes THAT handle and a
     * runtime holding a second binding of the same actor would keep
     * authorising statements after the fence flipped. `bindLocalActor` mints a
     * fresh frozen handle per call, so re-binding here produced a runtime the
     * host correctly refused — which is why the handle is required rather than
     * re-derived: the only caller, `buildLocalActorRuntime`, already holds the
     * one its binder issued.
     */
    actor: ActorHandle;
    /** Watches every write this head makes to the PARENT workspace, so the
     *  split can report which files this head changed. Its own view is what
     *  makes the answer exact under concurrency. */
    writeObserver?: WriteObserver;
  },
): Promise<AgentRuntime> {
  const { parentRuntime: parent } = opts;
  const sql = parent.storage.sql;

  if (opts.actorBinding.kind !== 'head') throw new KinuError('denied', 'The head runtime requires a registered head actor.');
  const actor = opts.actor;
  const physicalName = headAgentName(actor.storageKey);
  const stores = createAgentStores(() => sql, () => actor, parent.storage.transactionSync);

  const agentStateVfs = parent.agentStateVfs ?? parent.storage.vfs;
  const cwdPlane = parent.cwd ? createCwdPlaneVFS(parent.cwd, parent.checkpoints) : null;

  // The observer watches whichever plane the head's writes actually land on, so
  // the split can name the files this head changed. With a shared directory
  // that is this plane; without one it is the `parent` executor's surface below.
  const vfs = cwdPlane === null
    ? agentStateVfs
    : opts.writeObserver ? observeWrites(cwdPlane, opts.writeObserver) : cwdPlane;

  // One directory, one approval policy, one undo history: a head over a shared
  // plane runs the parent's own gated and checkpointed shell, with its own
  // scratch as HOME and TMPDIR, rather than an in-SQLite shell that cannot see
  // the files it is reading.
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

  // The parent workspace, over the parent runtime in this same process — the
  // same interface the cloud head satisfies with Durable Object RPC.
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

  // The parent's REAL host executor, shared unchanged: `run laptop` / `laptop.*`
  // reach the machine at the parent's cwd. This is the fork's real execution.
  const laptop = parent.executionRouter?.getProvider('laptop');

  if (laptop) executionRouter.register(laptop);

  // The head's plane carries the same mount table as its parent's — the
  // inherited `laptop` provider is what /pc resolves to here, and `/context`
  // is THIS head's own working history rather than the fork parent's.
  const agentVfs = withMountTable(vfs, [
    ...standardMounts((name) => executionRouter.getProvider(name)),
    contextMount({
      stores: () => ({ actorId: actor.actorId, claims: stores.claims, events: stores.eventRecorder }),
    }),
  ]);

  const checkpoints = parent.checkpoints;

  const runtimeOptions: Parameters<typeof buildRuntime>[0] = {
    transactionSync: parent.storage.transactionSync,
    // THIS head's own scaffold, not the workspace's. The agent-state plane is
    // shared by construction (`createWorkspaceFilesystem` takes no actor), so
    // the PATH is the only thing separating two actors' programs: with the
    // builder's default every head wrote its parent's `scaffold/agent.js` and
    // the parent would go on to execute its head's source. Core owns the rule
    // so the two backends cannot drift.
    scaffoldPath: actorScaffoldPath(opts.actorBinding),
    actor, sql, execRaw: parent.storage.execRaw, vfs: agentVfs, agentStateVfs,
    llm: parent.llm, executor: parent.executor, schedule: parent.schedule,
    memory: parent.memory, craftStore: parent.craftStore,
    spawnBranch: parent.spawnBranch, abortBranch: parent.abortBranch,
    executionRouter, shell,
  };

  if (checkpoints) runtimeOptions.checkpoints = checkpoints;
  const parentProfile = parent.turnProfile;
  const parentModelForRoute = parent.modelForRoute;

  if (parentProfile && parentModelForRoute) {
    runtimeOptions.modelLanes = {
      turnProfile: parentProfile,
      llm: parentModelForRoute,
    };
  }

  const runtime = buildRuntime(runtimeOptions);

  if (parent.cwd) return runtime;

  if (!parent.nodeHome || !parent.nodeRuntime) throw new KinuError('missing', 'The head has no canonical workspace file-plane owner.');
  const home = await facetHomeProvisioner(parent.nodeHome(), () => requireLocalActorWorkspace(parent.actor, actor))(physicalName);

  return parent.nodeRuntime(home, actor, runtime, opts.writeObserver);
}

/** How long after the command's own exit we keep reading its pipes. A pipe
 *  holds at most one buffer (64KB) of unread output at exit and node drains
 *  that in microseconds, so this is generous for the command and short enough
 *  that an orphaned grandchild's inherited pipe never becomes our problem. */
const EXITED_COMMAND_DRAIN_MS = 250;

const shellOptionsSchema = v.object({
  stdin: v.optional(v.string()),
  signal: v.optional(v.instance(AbortSignal)),
});

const abortContextSchema = v.object({ signal: v.optional(v.instance(AbortSignal)) });

export function createHostShell(cwd: string, env: NodeJS.ProcessEnv = process.env): Shell {
  return {
    exec(command: string, stdinOrOptions?: string | { stdin?: string; signal?: AbortSignal }) {
      return new Promise((resolve) => {
        const stdinText = v.safeParse(v.string(), stdinOrOptions);
        const options = v.safeParse(shellOptionsSchema, stdinOrOptions);
        const stdin = stdinText.success ? stdinText.output : options.success ? options.output.stdin : undefined;
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
          const aborted = signal?.aborted || signalName === 'SIGTERM' || signalName === 'SIGKILL';
          finish({
            stdout,
            stderr: aborted ? `${stderr}${stderr ? '\n' : ''}Command aborted.` : stderr,
            exitCode: code ?? (aborted ? 130 : 0),
          });
        };

        // `close` is the clean settle — the command exited AND every pipe it
        // handed out is closed, so all output is in hand. But a command that
        // backgrounds anything (`./server &`) leaves a grandchild holding the
        // inherited stdout pipe, and then `close` never comes until the SERVER
        // dies. So `exit` — the command itself is over — starts a bounded
        // drain instead: whatever the command wrote is already in the pipe
        // buffer and lands within the window; anything still writing after it
        // is an orphan, not this command's output.
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

/** Snapshot before any shell command — a command may mutate anything in the
 *  cwd; the engine dedupes to one snapshot per turn and skips no-op trees. */
function withCheckpointedShell(shell: Shell, checkpoints: FileCheckpoints, cwd: string): Shell {
  return {
    async exec(command, stdinOrOptions) {
      await checkpoints.ensureCheckpoint(cwd, 'shell exec');

      return shell.exec(command, stdinOrOptions);
    },
  };
}

function createLocalLaptopExecutor(
  cwd: string, shell: Shell, checkpoints: FileCheckpoints, resourceLimits: ResourceLimits | null,
): ExecutorProvider {
  const toHostPath = (path: string) => resolvePath(cwd, path || '.');

  const provider: ExecutorProvider = {
    name: 'laptop',
    kind: 'laptop',
    // The machine's own files, in the machine's own absolute paths. Writes
    // snapshot into the same shadow-git checkpoints the bound shell uses, so
    // /undo covers file-plane mutations too.
    files: createHostMountVFS(checkpoints),
    // Where the CLI was invoked — the directory its shell starts in and the
    // one its relative paths already resolve against (`toHostPath`).
    homeDir: async () => cwd,
    // Probed on this very machine rather than declared for a machine like it:
    // the model reads this set as a routing instruction (host-toolchain.ts says
    // why), so an unconditional claim of `git` and `npm` routes work onto tools
    // that may not be here.
    capabilities: new Set(hostToolchainCapabilities()),
    // Declared, not dropped: nothing on PATH settles `docker` or `gpu`, and an
    // omission reads to the model exactly like a measured absence.
    unmeasuredCapabilities: new Set(HOST_UNMEASURED_CAPABILITIES),
    positionalArgs: true,
    isAvailable: () => true,
    connect: async () => {},
    disconnect: async () => {},
    tools: {
      exec: {
        description: 'Run a shell command on the local machine in the directory where the CLI was invoked.',
        execute: async (command, context) => {
          const signal = readAbortSignal({ context });
          const result = await shell.exec(coerceText({ value: command }), signal ? { signal } : undefined);

          return commandResult(result);
        },
      },
      readFile: {
        description: 'Read a UTF-8 file from the local machine.',
        execute: async (path) => fs.readFile(toHostPath(coercePath({ value: path })), 'utf-8'),
      },
      writeFile: {
        description: 'Write a UTF-8 file on the local machine. Parent directories are created.',
        execute: async (path, content) => {
          const text = coerceText({ value: content });
          const p = toHostPath(coercePath({ value: path }));
          await checkpoints.ensureCheckpoint(checkpoints.workdirForPath(p), 'file write');
          await fs.mkdir(resolvePath(p, '..'), { recursive: true });
          await fs.writeFile(p, text, 'utf-8');

          return `Written ${text.length} bytes to ${p}`;
        },
      },
      listFiles: {
        description: 'List local directory entries as {name,type}.',
        execute: async (path = '.') => {
          const entries = await fs.readdir(toHostPath(coercePath({ value: path })), { withFileTypes: true });

          return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
        },
      },
    },
    types: `declare const laptop: {
  exec(command: string): Promise<${COMMAND_RESULT_TYPE}>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<string>;
  listFiles(path?: string): Promise<Array<{name: string; type: "dir" | "file"}>>;
};`,
  };

  return resourceLimits ? { ...provider, resourceLimits } : provider;
}

function coerceText(input: { value: unknown }): string {
  return String(input.value);
}

function coercePath(input: { value: unknown }): string {
  return input.value ? String(input.value) : '.';
}

function readAbortSignal(input: { context: unknown }): AbortSignal | undefined {
  const parsed = v.safeParse(abortContextSchema, input.context);

  return parsed.success ? parsed.output.signal : undefined;
}
