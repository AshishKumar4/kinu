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

import type {
  AgentRuntime, CraftStore as CoreCraftStore, LLM, ModelRouteResolution,
  ResolvedTurnProfile, Shell,
} from '@kinu.run/core';
import type {
  Schedule, Memory, VFS, SqlExec, SqlExecutor, SqlValue, RawSqlExec, WorkspaceSchemaSql,
} from '@kinu.run/core';
import type { ExecutorProvider, ResourceLimits } from '@kinu.run/core';
import type { RequestShellApproval, ShellApprovalPolicy } from '@kinu.run/core';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  type LLMProviderConfig, buildRuntime,
  observeWrites, type WriteObserver,
  WORKSPACE_IDENTITY_DDL,
  createParentExecutor, createParentWorkspaceVfs,
  type ParentWorkspaceHandle, type ParentRpcWrite, type ParentRpcResult,
  DefaultExecutionRouter, createInlineExecutor, formatExecResult,
  withMountTable, standardMounts,
  withApprovalGatedShell,
  createAgentConfigStore, initActorTables, initAgentConfigTable,
  resolveModelRoute,
  type ModelCallSink, type ModelOperationSink, type NodeHomeHost,
} from '@kinu.run/core';
import {
  createWorkspace as createWorkspaceFilesystem,
  nextWorkspaceGeneration,
  workspaceToolchainCapabilities,
} from '@kinu.run/core/workspace';
import { tolerate, tolerateAsync } from '@kinu.run/core/obs';
import type { RuntimePackage } from '@nimbus-sh/core/runtime/runtime-package.js';
import bashRuntime from '@nimbus-sh/runtime-bash';
import cpythonRuntime from '@nimbus-sh/runtime-cpython';
import { MemoryStore } from '@kinu.run/agent-utils';
import { CraftStore as AgentUtilsCraftStore } from '@kinu.run/agent-utils';
import { createSandboxedExecutor } from './executor';
import { createHostCheckpoints } from './checkpoints';
import { hostResourceLimits } from './cgroup-limits';
import { hostToolchainCapabilities, HOST_UNMEASURED_CAPABILITIES } from './host-toolchain';
import { createCwdPlaneVFS, createHostMountVFS } from './host-mount';
import { createLinuxFiber, initFiberTable, detectOrphanedFibers } from './fiber';
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
import type { OAuthCredential, FileCheckpoints } from '@kinu.run/core';
import { diagnostics, KinuError } from '@kinu.run/core/obs';
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';

export interface CLIRuntimeConfig {
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
   *  the stored chat model (agent_config) drives the seams instead. */
  llm: LLMProviderConfig | null;
  agentName?: string;
  providerCredentials?: LocalProviderCredentials;
  codexAuthStore?: LocalCodexAuthStore;
  codexConfigPath?: string;
  onCodexRefresh?: (credential: OAuthCredential) => void;
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
    const isRead = /^\s*(SELECT|WITH|PRAGMA)/i.test(query);
    const stmt = db.prepare<T, SQLQueryBindings[]>(query);
    if (isRead) return stmt.all(...bound);
    stmt.run(...bound);
    return [];
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
    const stmt = db.prepare<LocalSqlRow, SQLQueryBindings[]>(query);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) {
      return { toArray: () => stmt.all(...bound).map(toSqlRow) };
    }
    stmt.run(...bound);
    return { toArray: () => [] };
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
 * Adapt agent-utils MemoryStore to core Memory interface.
 */
function adaptMemory(store: MemoryStore, vfs: VFS): Memory {
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
    getAll() { return store.getAll(); },
  };
}

export function createCLIRuntime(
  db: Database,
  config: CLIRuntimeConfig,
): CLIRuntime {
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);

  initFiberTable(execRaw);
  const orphans = detectOrphanedFibers(sql);
  if (orphans.length > 0) {
    diagnostics.failure(
      'fiber.orphans_detected',
      new KinuError('cancelled', 'fibers from a previous run were interrupted by its exit'),
      { orphans: orphans.length },
    );
  }

  // Stable identity — core's DDL, not a second spelling of it. The hand-rolled
  // copy that used to be here silently lacked columns core had added.
  execRaw(WORKSPACE_IDENTITY_DDL);
  const existing = sql<{ id: string; name: string }>`SELECT id, name FROM workspace_identity LIMIT 1`;
  let agentId: string;
  let agentName: string;
  if (existing.length > 0 && existing[0]) {
    agentId = existing[0].id;
    agentName = existing[0].name;
  } else {
    agentId = crypto.randomUUID();
    agentName = config.agentName ?? 'agent';
    void sql`INSERT INTO workspace_identity (id, name) VALUES (${agentId}, ${agentName})`;
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
  // Shared by every typed agent_config read this runtime does — at
  // construction, and at exec time for the live shell-approval mode the gate
  // consults on every command. Its DDL runs here because a runtime built
  // WITHOUT `initWorkspaceSchema` (a branch worker, `kinu evolve`, a fixture)
  // still reads the table on its first gated command.
  initAgentConfigTable(execRaw);
  const agentConfig = createAgentConfigStore(sql);
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
        onCodexRefresh: config.onCodexRefresh,
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
  // routes — a session-less one included. `kinu evolve` used to spend a whole
  // search against lanes that threw for want of this line.
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
    onCodexRefresh: config.onCodexRefresh,
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
    fiber: createLinuxFiber(sql),
  };

  // `:memory:` is SQLite's in-memory sentinel, not a path — see the spawner's
  // own doc comment. Null tells it there is no directory rather than letting it
  // compute one from a value that is not a filename.
  const basePath = config.dbPath === ':memory:' ? null : config.dbPath.replace(/\.db$/, '');
  const { spawn: spawnBranch, abort: abortBranch } = createBranchSpawner(basePath, {
    llm: config.llm,
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
  });
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
  const shell: Shell = withApprovalGatedShell(
    cwd ? withCheckpointedShell(createHostShell(cwd), checkpoints, cwd) : workspace.shell,
    approvalPolicy,
  );
  const executionRouter = new DefaultExecutionRouter(approvalPolicy);
  const agentVfs = withMountTable(
    fileVfs,
    standardMounts((name) => executionRouter.getProvider(name)),
  );
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
  if (hostRoot !== null) {
    const hostShell = withCheckpointedShell(createHostShell(hostRoot), checkpoints, hostRoot);
    executionRouter.register(createLocalLaptopExecutor(hostRoot, hostShell, checkpoints, limits));
  }

  const runtime: CLIRuntime = Object.assign(buildRuntime({
    sql,
    execRaw,
    vfs: agentVfs,
    agentStateVfs,
    llm,
    executor: createSandboxedExecutor(),
    schedule,
    agentId,
    agentName,
    memory,
    craftStore,
    modelLanes,
    spawnBranch,
    abortBranch,
    // A CLI branch is a forked child process with its own SQLite FILE, not a
    // facet inside a shared durable object. `abort` already does the whole
    // reap — SIGTERM the child and drop it from `activeBranches` — so there is
    // no further resource for a terminal release to hand back and the two
    // verbs are genuinely the same operation here. The distinction is real on
    // CF, where release additionally WIPES the facet's SQLite out of the root
    // DO's shared quota; it is degenerate on this backend, not overlooked.
    releaseBranch: abortBranch,
    executionRouter, shell, checkpoints,
    setShellApprovalChannel: (fn) => { approvalChannel = fn; },
    setTurnFileLedgerProvider: (provider) => { turnFileLedgerProvider = provider; },
  }), {
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
  if (!cwd) {
    runtime.nodeHome = async () => ({ ...await workspace.privileged(), sql: workspaceSql });
  }
  return runtime;
}

/**
 * Join a subordinate to its parent's workspace plane, keeping its own SQL
 * identity, conversation, scaffold closure and branch state.
 *
 * A physical directory needs no joining. A child opened with its parent's cwd
 * already addresses the same bytes through its OWN executors, so its memory
 * and craft store stay private — which is the contract — and the one thing
 * genuinely shared per directory is the undo history: two agents editing one
 * tree want one restore point, not two that can each revert the other's work.
 *
 * The in-SQLite plane is per-database, so there a child cannot see its
 * parent's files at all without being moved onto them. That transplant is what
 * this function was written for, and it stays for exactly that case.
 */
export function shareLocalWorkspacePlane(
  actor: CLIRuntime,
  workspace: CLIRuntime,
): CLIRuntime {
  if (workspace.cwd && actor.cwd === workspace.cwd) {
    return Object.assign(actor, { checkpoints: workspace.checkpoints });
  }
  return Object.assign(actor, {
    storage: { ...actor.storage, vfs: workspace.storage.vfs },
    memory: workspace.memory,
    craftStore: workspace.craftStore,
    executionRouter: workspace.executionRouter,
    shell: workspace.shell,
    checkpoints: workspace.checkpoints,
    cwd: workspace.cwd ?? null,
  });
}

/**
 * The runtime a single local head (a fork of the parent workspace) runs over.
 *
 * The local mirror of the cloud head: its own private state, the parent's real
 * execution surface, and the parent's workspace reachable as the `parent`
 * EXECUTOR — `parent.exec` runs a command in the parent's real shell,
 * `parent.readFile` reads its files.
 *
 * Where the head's canonical FILES are depends on what the parent is bound to.
 * A parent bound to a physical directory shares it: a fork explores the same
 * project, so the head addresses those bytes directly and `parent.*` reaches
 * the same tree by another name. An in-SQLite parent has a per-database plane,
 * so the head gets its own tree (private scratch a sibling cannot see) and the
 * `parent` executor is the only way to its parent's files — a different
 * workspace, for the same reason the sandbox and the machine are.
 *
 * The head also inherits the parent's `laptop` provider unchanged, so `run
 * laptop` and `laptop.*` reach the real machine at the parent's cwd — the fork's
 * real execution, and what the doctrine promises a fork.
 */
export function buildCLIHeadRuntime(
  db: Database,
  opts: {
    parentRuntime: CLIRuntime; agentId: string; agentName: string;
    /** Watches every write this head makes to the PARENT workspace, so the
     *  split can report which files this head changed. Its own view is what
     *  makes the answer exact under concurrency. */
    writeObserver?: WriteObserver;
  },
): AgentRuntime {
  const { parentRuntime: parent } = opts;
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);

  // The scratch is a full-loop actor's storage, and this function is the only
  // thing that provisions it: no `initWorkspaceSchema` runs over a head's
  // database, and none should — a head has no workspace identity and no fork
  // lineage of its own. `initActorTables` is exactly that distinction, and the
  // three stores below are not the whole of what a head reads. The inline
  // executor registered on this same `sql` quotes the crafted-tool EMA from
  // `craft_scores` in `listTools`, seeds it in `createTool`, files a
  // misevolution veto in `evolution_events` and publishes to `agent_views`;
  // with only the VFS, memory and craft schemas below, a head raised
  // `no such table: craft_scores` on its first `workspace.listTools()` and a
  // tool it crafted was written and then reported as a failure.
  initActorTables(execRaw, sql);

  const workspace = createWorkspaceFilesystem({
    sql: nimbusSql(db),
    transactions: localTransactions(db),
    generation: nextWorkspaceGeneration(nimbusSql(db)),
    runtimes: WORKSPACE_RUNTIMES,
  });
  // What stays private is what makes this a fork rather than a second view of
  // the parent: its own scaffold, memory, craft store and transcript, in its
  // own scratch database.
  const agentStateVfs = workspace.vfs;
  const cwdPlane = parent.cwd ? createCwdPlaneVFS(parent.cwd, parent.checkpoints) : null;
  // The observer watches whichever plane the head's writes actually land on, so
  // the split can name the files this head changed. With a shared directory
  // that is this plane; without one it is the `parent` executor's surface below.
  const vfs = cwdPlane === null
    ? agentStateVfs
    : opts.writeObserver ? observeWrites(cwdPlane, opts.writeObserver) : cwdPlane;

  const memoryStore = new MemoryStore(agentStateVfs, sql);
  memoryStore.ensureSchema();
  const memory = adaptMemory(memoryStore, agentStateVfs);
  const craftStoreImpl = new AgentUtilsCraftStore(sql);
  craftStoreImpl.ensureSchema();
  const craftStore = adaptCraftStore(craftStoreImpl);

  // One directory, one approval policy, one undo history: a head over a shared
  // plane runs the parent's own gated and checkpointed shell rather than an
  // in-SQLite shell that cannot see the files it is reading.
  const shell = parent.cwd && parent.shell ? parent.shell : withApprovalGatedShell(workspace.shell);
  const executionRouter = new DefaultExecutionRouter();
  executionRouter.register(createInlineExecutor({
    vfs, memory, craftStore, shell, sql,
    toolchain: workspaceToolchainCapabilities(WORKSPACE_RUNTIMES),
  }));

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
    delete: (path) => attempt(path, async () => { await parentVfs.unlink(path); return null; }),
    exec: (command) => attempt('', async () => {
      if (!parent.shell) throw new Error('the parent workspace has no shell');
      return parent.shell.exec(command);
    }),
  };
  const parentFiles = createParentWorkspaceVfs(parentHandle);
  executionRouter.register(createParentExecutor({
    handle: parentHandle,
    vfs: opts.writeObserver ? observeWrites(parentFiles, opts.writeObserver) : parentFiles,
    workspaceName: opts.agentName,
  }));

  // The parent's REAL host executor, shared unchanged: `run laptop` / `laptop.*`
  // reach the machine at the parent's cwd. This is the fork's real execution.
  const laptop = parent.executionRouter?.getProvider('laptop');
  if (laptop) executionRouter.register(laptop);
  // The head's plane carries the same mount table as its parent's — the
  // inherited `laptop` provider is what /pc resolves to here.
  const agentVfs = withMountTable(vfs, standardMounts((name) => executionRouter.getProvider(name)));
  const checkpoints = parent.checkpoints;

  const runtimeOptions: Parameters<typeof buildRuntime>[0] = {
    sql, execRaw, vfs: agentVfs, agentStateVfs,
    llm: parent.llm, executor: parent.executor, schedule: parent.schedule,
    agentId: opts.agentId, agentName: opts.agentName, memory, craftStore,
    spawnBranch: parent.spawnBranch, abortBranch: parent.abortBranch,
    releaseBranch: parent.releaseBranch,
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
  return buildRuntime(runtimeOptions);
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

export function createHostShell(cwd: string): Shell {
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
          env: process.env,
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
export function withCheckpointedShell(shell: Shell, checkpoints: FileCheckpoints, cwd: string): Shell {
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
    // `git` and `npm` used to be claimed unconditionally, and the model reads
    // this set as a routing instruction (host-toolchain.ts says why).
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
          return formatExecResult(result);
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
  exec(command: string): Promise<string>;
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
