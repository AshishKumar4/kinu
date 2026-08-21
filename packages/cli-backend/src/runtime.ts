/**
 * Linux CLI runtime factory — uses bun:sqlite with agent-utils for
 * FTS5 memory search, the Nimbus workspace filesystem, and proper CraftStore.
 *
 * Implements the same primitives as cf-backend via adapter wrappers
 * that bridge agent-utils types to @kinu.run/core's interfaces.
 */

import type { AgentRuntime, CraftStore as CoreCraftStore, Shell } from '@kinu.run/core';
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
  withApprovalGatedShell,
  selectFastModel, createAgentConfigStore, initAgentConfigTable, initActorTables,
  type ModelCallSink, type NodeHomeHost,
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
import { createHostMountVFS } from './host-mount';
import { createLinuxFiber, initFiberTable, detectOrphanedFibers } from './fiber';
import { createBranchSpawner } from './branch-process';
import {
  createLocalModelResolver, createLocalProviderLLM, type LocalProviderCredentials,
} from './model-resolver';
import type { LocalCodexAuthStore } from './codex-auth-store';
import type { OAuthCredential, FileCheckpoints } from '@kinu.run/core';
import { diagnostics, KinuError } from '@kinu.run/core/obs';
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';

export interface CLIRuntimeConfig {
  dbPath: string;
  llm: LLMProviderConfig;
  judge?: LLMProviderConfig;
  agentName?: string;
  providerCredentials?: LocalProviderCredentials;
  codexAuthStore?: LocalCodexAuthStore;
  codexConfigPath?: string;
  onCodexRefresh?: (credential: OAuthCredential) => void;
  /**
   * Where the HOST plane is rooted — the `laptop` executor and the checkpointed
   * host shell behind it, i.e. the developer's own filesystem. Defaults to
   * `process.cwd()`, where `kinu` was invoked.
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
  /**
   * The three host-owned things a swarm node's private home needs — the uid-0
   * view of this workspace's filesystem, the principal registry that scopes
   * `/tmp`, and the SQL the uid allocation is a row in. *Isolation*.
   *
   * Present here and nowhere else because this backend's filesystem is an
   * in-isolate `NimbusWorkspace`: the hosted backend reaches its workspace by RPC
   * to another Durable Object, where every pid-less filesystem call is the session
   * user and `confinePrincipal` has no RPC at all, so there is nothing there to
   * hand over.
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

  const llm = createLocalProviderLLM({
    llm: config.llm,
    credentials: config.providerCredentials,
    codexAuthStore: config.codexAuthStore,
    onCodexRefresh: config.onCodexRefresh,
    // `rt.llm.complete` is the evolution engine's own reflection seam — the
    // turn loop drives its chat model directly and reports as `step_finish`.
    spend: { source: 'reflection', report },
  });
  // The mechanical-work tier: the chat vendor's own small model, for the
  // evolution engine's classification/labelling/short-reflection calls. Same
  // resolver, same credentials — one cheaper model id (core selectFastModel).
  // Resolved once here: a CLI process is one workspace's session, and a
  // `fast_model` change takes effect on the next one.
  const fastResolver = createLocalModelResolver({
    llm: config.llm, credentials: config.providerCredentials,
    codexAuthStore: config.codexAuthStore, onCodexRefresh: config.onCodexRefresh,
  });
  initAgentConfigTable(execRaw);
  // Shared for every typed agent_config read/write this runtime needs at
  // construction time — the fast-model lookup below, and the live shell-
  // approval-mode getter the execution seam's gate reads on every command
  // (see approvalPolicy below).
  const agentConfig = createAgentConfigStore(sql);
  const fast = selectFastModel({
    fastSpec: agentConfig.getFastModel(),
    chatSpec: fastResolver.normalizeSpecSync(null),
    providers: fastResolver.fastModelCandidates(),
  });
  // Only when it IS a different model — otherwise leave it unset so every
  // reader's documented `?? rt.llm` fallback is what runs, rather than a
  // second identical client.
  const fastLlm = fast.source === 'chat-model' ? undefined : createLocalProviderLLM({
    llm: config.llm, credentials: config.providerCredentials,
    codexAuthStore: config.codexAuthStore, onCodexRefresh: config.onCodexRefresh,
    spec: fast.spec,
    spend: { source: 'fast', report },
  });

  // Cross-model judge only when one is actually configured. Leaving this
  // undefined lets consumers apply their documented same-model fallback
  // (mcts/evaluation.ts judge ensemble, local-session auto-judge) instead of
  // hiding it here.
  const judgeModel = config.judge
    ? createLocalProviderLLM({
      llm: config.judge, credentials: config.providerCredentials,
      codexAuthStore: config.codexAuthStore, onCodexRefresh: config.onCodexRefresh,
      spend: { source: 'judge', report },
    })
    : undefined;

  const schedule: Schedule = {
    after: async (_ms, fn) => { setTimeout(fn, 0); },
    cron: async () => {},
    fiber: createLinuxFiber(sql),
  };

  // `:memory:` is SQLite's in-memory sentinel, not a path — see the spawner's
  // own doc comment. Null tells it there is no directory rather than letting it
  // compute one from a value that is not a filename.
  const basePath = config.dbPath === ':memory:' ? null : config.dbPath.replace(/\.db$/, '');
  const { spawn, abort } = createBranchSpawner(basePath, {
    llm: config.llm,
    providerCredentials: config.providerCredentials,
    codexConfigPath: config.codexConfigPath,
  });

  // The workspace filesystem: Nimbus over this agent's own SQLite, the same
  // component the cloud backend runs — a durable POSIX filesystem with a real
  // shell over it. The user's actual machine is the `laptop` EXECUTOR, not a
  // directory of this filesystem.
  const workspaceSql = nimbusSql(db);
  const workspace = createWorkspaceFilesystem({
    sql: workspaceSql,
    transactions: localTransactions(db),
    generation: nextWorkspaceGeneration(workspaceSql),
    runtimes: WORKSPACE_RUNTIMES,
  });
  const vfs = workspace.vfs;

  const memoryStore = new MemoryStore(vfs, sql);
  memoryStore.ensureSchema();
  const memory = adaptMemory(memoryStore, vfs);

  const craftStoreImpl = new AgentUtilsCraftStore(sql);
  craftStoreImpl.ensureSchema();
  const craftStore = adaptCraftStore(craftStoreImpl);

  // Shadow-git checkpoints for the HOST plane: both of its mutation paths
  // (`laptop.exec`, through the checkpointed shell, and `laptop.writeFile`)
  // snapshot their target directory before the first mutation of each turn.
  // Invisible until /undo. Built even when there is no host plane, because
  // `status()` and `list()` are asked either way and answer honestly — nothing
  // mutated the host, so there is nothing to restore.
  const checkpoints = createHostCheckpoints({ agent: agentName, keep: config.checkpointKeep });
  // The live shell-approval policy every gated exec boundary below consults:
  // `mode` reads agent_config directly (no staleness — a setShellApprovalMode
  // RPC takes effect on the very next command, no toolset rebuild needed);
  // `requestApproval` is a mutable slot a surface that owns a live user (ACP)
  // fills in later via AgentRuntime.setShellApprovalChannel — this runtime is
  // built before that surface exists, so the channel can only be attached
  // after the fact.
  let approvalChannel: RequestShellApproval | null = null;
  let turnFileLedgerProvider: Parameters<NonNullable<AgentRuntime['setTurnFileLedgerProvider']>>[0] = null;
  const approvalPolicy: ShellApprovalPolicy = {
    mode: () => agentConfig.getShellApprovalMode(),
    granted: (grant) => agentConfig.getShellApprovalGrants()
      .some((g) => g.rule === grant.rule && g.executor === grant.executor),
    requestApproval: (req) => approvalChannel?.(req) ?? Promise.resolve(null),
  };
  // The `workspace` runtime is the workspace filesystem's own shell, gated
  // here because `gateProviderExec` deliberately skips it (execution/
  // approval.ts). The host machine's shell is NOT gated here: it reaches the
  // model only as the `laptop` ExecutorProvider below, which the router gates
  // under that name. It used to be wrapped in both places, which reviewed
  // every host command twice and asked the user twice for one command.
  // Checkpointing still sits inside the gate, so a refused `rm -rf /` does
  // not spend a snapshot on a command that never ran.
  const shell: Shell = withApprovalGatedShell(workspace.shell, approvalPolicy);
  const executionRouter = new DefaultExecutionRouter(approvalPolicy);
  // Every executor registered below runs its commands in THIS process's
  // container, so each carries its measured cgroup limits — the truth `nproc`
  // cannot tell the model. Null off a cgroup, and then nothing is claimed.
  const limits = hostResourceLimits();
  // `sql` is not optional in practice: workspace.createTool seeds the crafted
  // tool's score prior and writes the misevolution veto trail through it, and
  // listTools quotes real EMA scores from it.
  const inlineOptions: Parameters<typeof createInlineExecutor>[0] = {
    vfs, memory, craftStore, shell, sql,
    ledger: () => turnFileLedgerProvider?.(),
    toolchain: workspaceToolchainCapabilities(WORKSPACE_RUNTIMES),
  };
  if (limits) inlineOptions.resourceLimits = limits;
  executionRouter.register(createInlineExecutor(inlineOptions));
  // The HOST plane, when this runtime is allowed one. Withholding it is the
  // whole isolation story for a measurement harness — see CLIRuntimeConfig.
  const hostRoot = config.hostRoot === undefined ? process.cwd() : config.hostRoot;
  if (hostRoot !== null) {
    const hostShell = withCheckpointedShell(createHostShell(hostRoot), checkpoints, hostRoot);
    executionRouter.register(createLocalLaptopExecutor(hostRoot, hostShell, checkpoints, limits));
  }

  // `Object.assign` onto the built runtime rather than a spread, so the one
  // channel `buildRuntime` has no slot for is added to the same object every
  // other seam already holds a reference to.
  return Object.assign(buildRuntime({
    sql, execRaw, vfs, llm, executor: createSandboxedExecutor(), schedule,
    agentId, agentName, memory, craftStore, judgeModel, fastLlm,
    spawnBranch: spawn, abortBranch: abort,
    // A CLI branch is a forked child process with its own SQLite FILE, not a
    // facet inside a shared durable object. `abort` already does the whole
    // reap — SIGTERM the child and drop it from `activeBranches` — so there is
    // no further resource for a terminal release to hand back and the two
    // verbs are genuinely the same operation here. The distinction is real on
    // CF, where release additionally WIPES the facet's SQLite out of the root
    // DO's shared quota; it is degenerate on this backend, not overlooked.
    releaseBranch: abort,
    executionRouter, shell, checkpoints,
    setShellApprovalChannel: (fn) => { approvalChannel = fn; },
    setTurnFileLedgerProvider: (provider) => { turnFileLedgerProvider = provider; },
  }), {
    setModelCallSink: (sink: ModelCallSink | null) => { modelCallSink = sink; },
    // A swarm node's home is provisioned against THIS filesystem — the same bytes
    // `vfs` and the workspace shell address, so a node still reads everything the
    // origin has — and the uid it is chown'ed to is a row in the same database
    // that filesystem lives in, so a home outlives the activation that made it.
    nodeHome: async () => ({ ...await workspace.privileged(), sql: workspaceSql }),
  });
}

/**
 * The runtime a single local head (a fork of the parent workspace) runs over.
 *
 * The local mirror of the cloud head: its OWN durable workspace filesystem
 * (private scratch a sibling cannot see), the parent's real execution surface,
 * and the parent's workspace reachable as the `parent` EXECUTOR — `parent.exec`
 * runs a command in the parent's real shell, `parent.readFile` reads its files.
 * It is not a directory of the head's own filesystem, for the same reason the
 * sandbox and the machine are not: it is a different workspace.
 *
 * The head also inherits the parent's `laptop` provider unchanged, so `run
 * laptop` and `laptop.*` reach the real machine at the parent's cwd — the fork's
 * real execution, and what the doctrine promises a fork.
 */
export function buildCLIHeadRuntime(
  db: Database,
  opts: {
    parentRuntime: AgentRuntime; cwd: string; agentId: string; agentName: string;
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
  const vfs = workspace.vfs;

  const memoryStore = new MemoryStore(vfs, sql);
  memoryStore.ensureSchema();
  const memory = adaptMemory(memoryStore, vfs);
  const craftStoreImpl = new AgentUtilsCraftStore(sql);
  craftStoreImpl.ensureSchema();
  const craftStore = adaptCraftStore(craftStoreImpl);

  const shell = withApprovalGatedShell(workspace.shell);
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
  const checkpoints = parent.checkpoints;

  const runtimeOptions: Parameters<typeof buildRuntime>[0] = {
    sql, execRaw, vfs, llm: parent.llm, executor: parent.executor, schedule: parent.schedule,
    agentId: opts.agentId, agentName: opts.agentName, memory, craftStore, judgeModel: parent.judgeModel,
    spawnBranch: parent.spawnBranch, abortBranch: parent.abortBranch,
    releaseBranch: parent.releaseBranch,
    executionRouter, shell,
  };
  if (checkpoints) runtimeOptions.checkpoints = checkpoints;
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
