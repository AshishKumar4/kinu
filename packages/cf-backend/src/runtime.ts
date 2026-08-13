/**
 * CF runtime adapter — bridges Think's DO context to core's AgentRuntime.
 *
 * Storage is pure DO SQLite — no R2, no @cloudflare/shell:
 *   VFS      → Nimbus over this DO's SQLite. The whole workspace filesystem.
 *   Shell    → Nimbus's shell over those same bytes.
 *   Memory   → MemoryStore (FTS5-indexed markdown chunks)
 *   CraftStore → CraftStore (FTS5-indexed tool storage)
 *
 * Uses real Agent SDK APIs for infrastructure:
 *   Fibers   → Agent.runFiber() (durable, checkpoint/resume via stash)
 *   Branches → Agent.subAgent() (Facets — co-located child DOs)
 *   LLM      → provider registry (Workers AI uses the user's Cloudflare OAuth)
 */

import type {
  AgentRuntime, BranchHandle,
  VFS as CoreVFS, Executor, LLM, Schedule, Identity,
  SqlExecutor, RawSqlExec,
  ExecuteResult, ResolvedProvider,
  CraftStore as CoreCraftStore, CraftedTool as CoreCraftedTool,
  FiberCtx, ExecutionRouter,
  TurnAccumulator,
  DeferredApprovalChannel,
} from "@proteus/core";
import {
  createWorkspaceFilesystem, nextWorkspaceGeneration, type WorkspaceVFS,
  DefaultExecutionRouter, createInlineExecutor,
  withApprovalGatedShell, type ShellApprovalPolicy,
  createSandboxExecutor, createDeviceTunnelExecutor, type DeviceTransport,
  createNimbusExecutor, type NimbusSandboxHandle,
  createCloudflareVectorStore, createWorkersAIEmbedder, createNoopVectorStore,
  effortFor,
  createAgentConfigStore, selectFastModel,
  type VectorStore, type VectorizeIndex,
} from "@proteus/core";
import type { SandboxHandle } from "@proteus/core";
import { getSandbox } from "@cloudflare/sandbox";
import { previewHostSuffix } from "./lib/preview-origin.js";
import { Nimbus } from "@nimbus-sh/sdk";
import { MemoryStore } from "@proteus/agent-utils/memory";
import { CraftStore as AgentUtilsCraftStore } from "@proteus/agent-utils/stores";
import { generateText } from "ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { Agent } from "agents";
import { abortExplorationFacet, spawnBranchFacet } from "./facet-spawn.js";
import { createHubDeviceTransport } from "./device-transport.js";
import { createAgentProviderRegistry, type UserCredentialSource } from "./providers/agent-registry.js";
import { resolveJudgeModelSelection } from "./providers/judge-model.js";
import type { UserCaller } from "./user/workspace-capability.js";
import { adaptMemory, backfillMemoryVectors } from "./memory-sync.js";
import { agentAffinityKey, explorePrompt, extractCodeBlock, formatInheritedContext, missionCallUsage, reflectionPrompt } from "@proteus/core";
import type { UserDO } from "./user/user-do.js";
import {
  nimbusSandboxConfig,
  nimbusSandboxIdForAgent,
  nimbusSubjectForAgent,
  nimbusTenantForUser,
} from "./nimbus-route.js";

/**
 * The agent surface these runtime builders need — the bare agents-SDK `Agent`
 * members, nothing from Think. Narrow on purpose: `ExplorationAgent` extends
 * `Agent<Env>` (never `ActorAgent`, so a head can't acquire the think/team/peers
 * surface) and still has to be able to build a runtime, so requiring `Think`
 * here would have made the fork impossible.
 *
 * `env`/`ctx` are `protected` on the DurableObject base (not reachable by these
 * free functions), but the runtime is conceptually an extension of the agent and
 * legitimately needs them. A subclass (which DOES have access) passes `this`
 * cast to this view — so the access is sound, just opened to these helpers.
 */
type AgentHost = Pick<Agent<Env>, 'name' | 'sql' | 'runFiber' | 'subAgent' | 'abortSubAgent'> & {
  readonly env: Env;
  readonly ctx: DurableObjectState;
  /** The turn's ledger + budget, when this actor has one — ActorAgent
   *  (orchestrator, subordinate) does; ExplorationAgent (a head/fork) does
   *  not, so the `workspace` provider's editFile/readFile/writeFile fall
   *  back to a private ledger there. Optional, not narrowed further than
   *  TurnAccumulator's own two turn-scoped fields, so this stays the same
   *  "bare surface" the type's own docstring commits to. */
  readonly acc?: Pick<TurnAccumulator, 'files' | 'context'>;
};

/**
 * The one bridge between the Agents SDK's `Agent.sql` and the SqlExecutor
 * primitive. The SDK types its bound values as scalars only, so it does not
 * nominally satisfy a primitive that admits ArrayBuffer — an assertion is
 * unavoidable, and this is the single place it is made.
 */
function boundSql(agent: AgentHost): SqlExecutor {
  return agent.sql.bind(agent) as unknown as SqlExecutor;
}

/**
 * The actor's identity bootstrap + exec-plane keying — the two things that
 * differ between a top-level workspace DO and a facet actor riding it.
 *
 * The orchestrator passes its own owner lookup (workspace_identity) and its
 * DO name; a facet actor passes its own owner row and the PARENT workspace
 * name, so it shares the workspace's sandbox container, Nimbus session, and
 * device consent instead of materializing fresh planes keyed by facet name.
 * A fork's window onto its parent is not configured here: it is an EXECUTOR
 * the facet registers post-construction (`createParentExecutor`), the same way
 * the sandbox and the device are.
 */
export interface ActorRuntimeIdentity {
  /** Owner userId, or null while unclaimed. Resolved per call — never cached
   *  here, so a first use before owner claim can't bake in null. */
  ownerUserId(): string | null;
  /** The workspace whose exec planes (sandbox, nimbus, /pc consent) this
   *  actor rides. */
  workspaceName: string;
  /** The workspace capability token this actor presents to the UserDO — its
   *  own for a workspace DO, its parent's for a facet. Null until claimed. */
  capabilityToken(): Promise<string | null>;
}

function userDOStubFor(agent: AgentHost, actor: ActorRuntimeIdentity): DurableObjectStub<UserDO> | null {
  const userId = actor.ownerUserId();
  if (!userId) return null;
  return agent.env.UserDO.get(agent.env.UserDO.idFromName(userId)) as DurableObjectStub<UserDO>;
}

/** This actor's identity for a privileged UserDO call. Rejects — rather than
 *  degrading to some weaker principal — when the workspace has no token. */
async function userCallerFor(actor: ActorRuntimeIdentity): Promise<UserCaller> {
  const workspaceToken = await actor.capabilityToken();
  if (!workspaceToken) throw new Error('This workspace has not been issued a capability token yet.');
  return { workspaceToken };
}

/** The credential source for a provider registry built inside an actor. Null
 *  when the workspace is unclaimed, leaving only env-bound providers usable —
 *  the pre-existing behaviour for an ownerless agent. */
function userCredentialSourceFor(agent: AgentHost, actor: ActorRuntimeIdentity): UserCredentialSource | null {
  const stub = userDOStubFor(agent, actor);
  return stub ? { stub, caller: () => userCallerFor(actor) } : null;
}

/** Extended runtime that exposes the durable base for the parent-file RPC a
 *  fork reads through, the device transport for per-turn laptop-status
 *  refreshes, and the Vectorize-backed vector store for semantic memory. */
export type CFRuntime = AgentRuntime & {
  /** `Storage.vfs`, typed — the workspace filesystem, plus the two operations
   *  beyond the seven that `mv` and `rm -r` need. Also what the parent-file RPC
   *  serves to a fork, so a fork reads exactly the bytes its parent's shell
   *  does. */
  localVfs: WorkspaceVFS;
  /** The laptop runtime's hub transport. `refreshStatus()` is awaited at turn
   *  start so the turn's context reflects the CURRENT device state. */
  deviceTransport: DeviceTransport;
  /** Vectorize-backed semantic memory. Noop fallback when no binding. */
  vectorStore: import("@proteus/core").VectorStore;
  /** The live sandbox container handle (for /workspace backup/restore), or null
   *  when no Sandbox binding / preview host. Single source for the orchestrator. */
  sandboxHandle: SandboxHandle | null;
};

/** Optional hooks the orchestrator can inject into the CF runtime. */
export interface CFRuntimeHooks {
  /**
   * Fires synchronously from workspace.createTool after a successful
   * create/update. PreambleCraftedExecutor does not need it because it reads
   * craftStore.list() live; other adapters can use it for eager notification.
   */
  onToolRegistered?: (tool: { name: string; description: string; code: string }) => void;
  /**
   * Where a 'gate'-tier command goes when nobody is there to approve it — the
   * owner's parked-action queue (core's safety/deferred-approval.ts). A thunk,
   * and read at exec time, for the two reasons the runtime's other thunks are:
   * the queue's wake rides the orchestrator's signal seam, which this builder
   * deliberately cannot see (`AgentHost` is the bare agents-SDK surface), and
   * resolving it during construction would re-enter the caller's own lazy
   * runtime getter. Returning undefined — a head, a subordinate — means no
   * queue: neither owns a needs-you queue its parked actions could be decided
   * from, so 'strict' keeps its explanatory refusal there.
   */
  deferrals?: () => DeferredApprovalChannel | undefined;
}

/**
 * Build a full AgentRuntime from a Think agent's DO context.
 */
export function createCFRuntime(agent: AgentHost, actor: ActorRuntimeIdentity, hooks: CFRuntimeHooks = {}): CFRuntime {
  const sql = boundSql(agent);
  const execRaw: RawSqlExec = (ddl: string) => agent.ctx.storage.sql.exec(ddl);

  // The workspace filesystem: Nimbus over this Durable Object's OWN SQLite. A
  // real filesystem with a real shell over the same bytes, and the only one —
  // the sandbox, a Nimbus session and the user's machine are EXECUTORS, reached
  // through their own namespaces in their own native paths.
  //
  // The generation counter must never repeat for this database, or a dead
  // process keeps live write authority; DO storage is what makes it durable.
  const workspace = createWorkspaceFilesystem({
    sql: agent.ctx.storage.sql,
    transactions: agent.ctx,
    generation: nextWorkspaceGeneration(agent.ctx.storage.sql),
  });
  const vfs: CoreVFS = workspace.vfs;

  // MemoryStore from agent-utils — FTS5-indexed search over the workspace
  // filesystem itself, so `memory/MEMORY.md` is the same file the agent reads
  // with the `file` tool and greps in the shell.
  const memoryStore = new MemoryStore(vfs, sql);
  memoryStore.ensureSchema();

  // Vectorize-backed semantic memory, scoped to this workspace's namespace.
  // Noop when env.AI / env.MEMORY_VECTORS aren't configured, so hybrid search
  // degrades to FTS5-only. Built before the memory adapter so writes embed.
  const vectorStore = buildVectorStore(agent, actor);
  // Owns the semantic-index completeness markers, read by the backfill and
  // cleared by the write path when a sync fails.
  const memoryConfig = createAgentConfigStore(sql);
  // One-time backfill of chunks indexed before the vector store existed.
  // Fire-and-forget (same pattern as deviceTransport.refreshStatus): bounded
  // per boot, idempotent, and a no-op once the marker is set.
  void backfillMemoryVectors(memoryStore, memoryConfig, vectorStore);

  // CraftStore from agent-utils — FTS5-indexed tool storage
  const craftStoreImpl = new AgentUtilsCraftStore(sql);
  craftStoreImpl.ensureSchema();

  // Adapt MemoryStore to core's Memory interface (writes sync to vectorStore)
  const memory = adaptMemory(memoryStore, vectorStore, memoryConfig);

  // Adapt CraftStore to core's CraftStore interface
  const craftStore = adaptCraftStore(craftStoreImpl);

  const envForExec = agent.env as Env & Record<string, unknown>;
  if (!envForExec.LOADER) {
    throw new Error("CF runtime requires env.LOADER binding (worker_loaders in wrangler.jsonc)");
  }
  const executor = createExecutor(envForExec.LOADER);
  const llm = createDualPathLLM(agent, actor);
  const schedule = createRealSchedule(agent);
  const identity = createIdentity(agent, vfs, sql);

  // Execution router — manages codemode providers (workspace, nimbus, sandbox, laptop)
  // Live shell-approval policy every gated exec boundary consults (`run`'s
  // workspace/router dispatch and every ExecutorProvider's exec — see
  // execution/approval.ts). `mode` reads agent_config directly off the SAME
  // store the memory backfill above already opened, so a setShellApprovalMode
  // RPC takes effect on the very next command with no toolset rebuild needed.
  // `deferrals` is what stops an unattended run dying on its first `sudo`: with
  // no interactive channel on this backend, a 'gate' decision under 'strict'
  // used to be an explanatory refusal, so a night's run stopped there. It is
  // now parked on the owner and the model is told so — never told it ran.
  // A getter, so the queue is resolved at exec time like every other member of
  // this policy — see ShellApprovalPolicy's own doc on live reads.
  const approvalPolicy: ShellApprovalPolicy = {
    mode: () => memoryConfig.getShellApprovalMode(),
    get deferrals() { return hooks.deferrals?.(); },
  };
  // The workspace shell is Nimbus's, over the same bytes `vfs` addresses.
  // Gated at the Shell object, so what it wraps is transparent to the seam.
  const shell = withApprovalGatedShell(workspace.shell, approvalPolicy);
  const executionRouter: ExecutionRouter = new DefaultExecutionRouter(approvalPolicy);
  executionRouter.register(createInlineExecutor({
    vfs, memory, craftStore, shell,
    // sql is used by workspace.listTools() to look up EMA craft_scores.
    sql,
    // Optional eager notification; PreambleCraftedExecutor live-reads CraftStore.
    onToolRegistered: hooks.onToolRegistered,
    // Shares the native `file` tool's turn ledger/budget with workspace.*
    // (editFile's gate, readFile/writeFile's observe). The thunks are passed
    // unconditionally and read `agent.acc` only when actually CALLED (a tool
    // execution, always well after this runtime finished constructing) —
    // never here, synchronously, inside this lazy getter's own body, where
    // touching `agent.acc` (ActorAgent only) could recurse back into
    // `this.rt` through `this.orch`'s own dependency chain before `_rt` is
    // cached. Undefined for a head (ExplorationAgent has no `acc`) — the
    // executor falls back to a private ledger there, same as before this
    // existed.
    ledger: () => agent.acc?.files,
    budget: () => agent.acc?.context,
  }));
  // Register Sandbox executor — Proteus's primary remote exec surface.
  // Backed by @cloudflare/sandbox: one Linux container per agent, keyed
  // by the agent's stable name. `PREVIEW_HOST_SUFFIX` is the zone the SDK
  // builds preview URLs on — `<port>-<sandbox>-<token>.<suffix>`, routed back
  // by preview-proxy.ts. `sandboxId` is the stable DO key those URLs carry.
  const env = agent.env as Env & Record<string, unknown>;
  const previewSuffix = previewHostSuffix(env) ?? undefined;
  const sandboxId = `proteus-${actor.workspaceName}`;
  // Every remote mount exposes the environment's REAL root ('/'); the
  let sandboxHandle: SandboxHandle | null = null;
  if (env.Sandbox) {
    try {
      const rawHandle = getSandbox(
        env.Sandbox as Parameters<typeof getSandbox>[0],
        sandboxId,
        { normalizeId: true },
      ) as unknown as SandboxHandle;
      const configStore = createAgentConfigStore(sql);
      const handle = createRestoringSandboxHandle(rawHandle, configStore);
      sandboxHandle = handle;
      // The executor carries its own file view over this same (restoring) raw
      // handle, for the file manager's sandbox pane. An unset
      // PREVIEW_HOST_SUFFIX turns off previews alone: exec, files and the
      // release engine keep working, and port exposure refuses with the
      // preview-specific reason.
      executionRouter.register(createSandboxExecutor(handle, previewSuffix));
      console.log(`[proteus] SandboxExecutor registered (${previewSuffix ? `previews=*.${previewSuffix}` : "previews off — PREVIEW_HOST_SUFFIX unset"} id=${sandboxId})`);
    } catch (err) {
      console.warn("[proteus] Failed to register SandboxExecutor:", (err as Error).message);
      executionRouter.register(createSandboxExecutor());
    }
  } else {
    executionRouter.register(createSandboxExecutor());
  }

  // Register Nimbus — Proteus's built-in lightweight sandbox. This uses the
  // official SDK against the local NIMBUS_SESSION binding, so there are no
  // endpoint/token secrets. The handle is lazy: no session is touched until
  // the agent actually calls nimbus.*.
  if (env.NIMBUS_SESSION) {
    try {
      const nimbusBox = createAgentNimbusHandle(agent, actor);
      executionRouter.register(createNimbusExecutor({ box: nimbusBox }));
      console.log('[proteus] NimbusExecutor registered (NIMBUS_SESSION binding)');
    } catch (err) {
      console.warn('[proteus] Failed to register NimbusExecutor:', (err as Error).message);
      executionRouter.register(createNimbusExecutor());
    }
  } else {
    executionRouter.register(createNimbusExecutor());
  }

  // Register the laptop executor. The device socket lives on the user's UserDO
  // (the user-level hub), so this executor FORWARDS each JSON-RPC call there —
  // one connected device serves all of the user's agents.
  const cliCwdForDevice = () =>
    typeof (agent as unknown as { getCliCwdForDevice?: () => string | null }).getCliCwdForDevice === 'function'
      ? (agent as unknown as { getCliCwdForDevice: () => string | null }).getCliCwdForDevice()
      : null;
  const deviceTransport = createHubDeviceTransport({
    hub: () => userDOStubFor(agent, actor),
    caller: () => userCallerFor(actor),
    agentName: actor.workspaceName,
    cliCwd: cliCwdForDevice,
    checkpointMeta: () => {
      const host = agent as unknown as { getCheckpointMetaForDevice?: () => { turnId: string; sessionId: string } | null };
      return typeof host.getCheckpointMetaForDevice === 'function' ? host.getCheckpointMetaForDevice() : null;
    },
  });
  void deviceTransport.refreshStatus();
  // The executor's file view scopes paths to the consented subtree (connect dir
  // / home) unless the agent holds the full-filesystem consent tier on the hub.
  // Action consent (ask-once-then-remember) still applies to every RPC beneath.
  executionRouter.register(createDeviceTunnelExecutor(deviceTransport, {
    consentedRoot: cliCwdForDevice,
    hasFullFilesystem: async () => {
      const hub = userDOStubFor(agent, actor);
      if (!hub) return false;
      try {
        return (await hub.getDeviceFsConsent(await userCallerFor(actor), actor.workspaceName)).fullFilesystem;
      }
      catch { return false; } // consent unverifiable → subtree scope (fail closed)
    },
  }));

  return {
    storage: { vfs, sql, execRaw },
    memory, executor, llm, schedule, identity, craftStore,
    judgeModel: createJudgeLLM(agent, actor),
    fastLlm: createFastLLM(agent, actor),
    spawnBranch: createFacetSpawner(agent, actor),
    abortBranch: createFacetAborter(agent),
    executionRouter,
    shell,
    localVfs: workspace.vfs,
    deviceTransport,
    vectorStore,
    sandboxHandle,
  };
}


function publicOriginForNimbus(env: Env & Record<string, unknown>): string {
  if (typeof env.CLI_PUBLIC_ORIGIN === "string" && env.CLI_PUBLIC_ORIGIN.length > 0) {
    return env.CLI_PUBLIC_ORIGIN.replace(/\/+$/, "");
  }
  return "https://proteus.local";
}

function createAgentNimbusHandle(agent: AgentHost, actor: ActorRuntimeIdentity): NimbusSandboxHandle {
  let cachedKey = "";
  let cachedBox: any = null;

  const current = () => {
    const env = agent.env as Env & Record<string, unknown>;
    const tenant = nimbusTenantForUser(actor.ownerUserId());
    const subject = nimbusSubjectForAgent(actor.workspaceName);
    const sessionId = nimbusSandboxIdForAgent(actor.workspaceName);
    const origin = publicOriginForNimbus(env);
    const key = `${origin}|${tenant}|${subject}|${sessionId}`;
    if (!cachedBox || cachedKey !== key) {
      cachedKey = key;
      cachedBox = Nimbus.fromEnv(
        env as Record<string, unknown>,
        nimbusSandboxConfig(origin, tenant, subject),
        { binding: "NIMBUS_SESSION" },
      ).sandbox(sessionId, {
        tenant,
        subject,
        root: "/home/user",
      });
    }
    return cachedBox;
  };

  return {
    ready: () => current().ready(),
    exec: (command, options) => current().exec(command, options),
    startProcess: (command, options) => current().startProcess(command, options),
    runCode: (code, options) => current().runCode(code, options),
    files: {
      read: (path) => current().files.read(path),
      readBytes: (path) => current().files.readBytes(path),
      write: (path, content) => current().files.write(path, content),
      list: (path) => current().files.list(path),
      exists: (path) => current().files.exists(path),
      mkdir: (path) => current().files.mkdir(path),
      delete: (path, options) => current().files.delete(path, options),
    },
    runtimes: {
      ensure: (specs, options) => current().runtimes.ensure(specs, options),
      install: (spec, options) => current().runtimes.install(spec, options),
      list: () => current().runtimes.list(),
    },
    processes: {
      list: () => current().processes.list(),
      kill: (pid) => current().processes.kill(pid),
      logs: (pid, options) => current().processes.logs(pid, options),
    },
    ports: {
      expose: (port) => current().ports.expose(port),
      unexpose: (port) => current().ports.unexpose(port),
      list: () => current().ports.list(),
      url: (port) => current().ports.url(port),
    },
  };
}

function createRestoringSandboxHandle(
  handle: SandboxHandle,
  config: ReturnType<typeof createAgentConfigStore>,
): SandboxHandle {
  let restored = false;
  const restoreOnce = async () => {
    if (restored) return;
    restored = true;
    const backup = config.getWorkspaceBackup();
    if (!backup) return;
    try { await handle.restoreBackup(backup); }
    catch (err) { console.warn('[proteus] workspace restore failed:', (err as Error).message); }
  };
  const before = async <T>(fn: () => Promise<T>): Promise<T> => {
    await restoreOnce();
    return fn();
  };
  return {
    exec: (command, opts) => before(() => handle.exec(command, opts)),
    readFile: (path, opts) => before(() => handle.readFile(path, opts)),
    writeFile: (path, content, opts) => before(() => handle.writeFile(path, content, opts)),
    listFiles: (path, opts) => before(() => handle.listFiles(path, opts)),
    deleteFile: (path) => before(() => handle.deleteFile(path)),
    exposePort: (port, opts) => before(() => handle.exposePort(port, opts)),
    unexposePort: (port) => before(() => Promise.resolve(handle.unexposePort(port))),
    getExposedPorts: (hostname) => before(() => handle.getExposedPorts(hostname)),
    createBackup: (opts) => handle.createBackup(opts),
    restoreBackup: (backup) => handle.restoreBackup(backup),
  };
}

// ── Adapters: agent-utils → core interfaces ──────────────────────
// adaptMemory + backfillMemoryVectors live in ./memory-sync (dependency-light,
// unit-tested against a fake VectorStore).

/**
 * Build the workspace's semantic memory store. Constructs a Cloudflare-Vectorize
 * store (scoped to this workspace's namespace) only when both env.AI (Workers AI
 * embedder) and env.MEMORY_VECTORS (Vectorize index) are bound; otherwise a noop
 * that makes hybrid search degrade to FTS5-only.
 */
function buildVectorStore(agent: AgentHost, actor: ActorRuntimeIdentity): VectorStore {
  const aiBinding = (agent.env as Env & Record<string, unknown>).AI;
  const vectorizeBinding = (agent.env as Env & Record<string, unknown>).MEMORY_VECTORS;
  if (!aiBinding || typeof aiBinding === 'string' || !vectorizeBinding) {
    return createNoopVectorStore();
  }
  try {
    const embedder = createWorkersAIEmbedder({
      aiBinding: aiBinding as Parameters<typeof createWorkersAIEmbedder>[0]['aiBinding'],
      model: '@cf/baai/bge-small-en-v1.5',
      dimensions: 384,
    });
    const store = createCloudflareVectorStore({
      index: vectorizeBinding as VectorizeIndex,
      embedder,
      // Shared index across all of the user's workspaces — scope every write
      // and query to this workspace so memories never leak across agents.
      namespace: actor.workspaceName,
    });
    console.log(`[proteus] VectorStore (Cloudflare Vectorize) registered (namespace=${actor.workspaceName})`);
    return store;
  } catch (err) {
    console.warn('[proteus] VectorStore construction failed; falling back to noop:', (err as Error).message);
    return createNoopVectorStore();
  }
}

function adaptCraftStore(impl: AgentUtilsCraftStore): CoreCraftStore {
  return {
    create(t) {
      impl.create({
        name: t.name, description: t.description,
        params: t.params as Record<string, string> | undefined ?? undefined,
        code: t.code, scope: (t.scope ?? "local") as "local" | "shared",
      });
    },
    update(name, patch) {
      impl.update(name, patch);
    },
    get(name) {
      const tool = impl.get(name);
      return tool ? adaptCraftedTool(tool) : undefined;
    },
    delete(name) { impl.delete(name); },
    list() { return impl.list().map(adaptCraftedTool); },
    search(query, limit) { return impl.search(query, limit).map(adaptCraftedTool); },
    getAll() { return impl.getAll().map(adaptCraftedTool); },
  };
}

function adaptCraftedTool(t: { name: string; description: string; params: Record<string, string> | null; code: string; scope: string; createdAt: number; updatedAt: number }): CoreCraftedTool {
  return {
    name: t.name,
    description: t.description,
    params: t.params,
    code: t.code,
    scope: t.scope as CoreCraftedTool["scope"],
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

// ── Executor: LOADER-backed DynamicWorkerExecutor ──
//
// delegates to @cloudflare/codemode's DynamicWorkerExecutor which
// spawns a child Worker per execute() call via env.LOADER.get(). Replaces
// the broken new-Function() fallback that fired "Code generation from
// strings disallowed" in production. Consumer: scaffold/modify.ts parse gate
// is the only caller today; any future caller gets the same real-Worker
// isolation semantics.

function createExecutor(loader: unknown): Executor {
  const dwe = new DynamicWorkerExecutor({ loader: loader as ConstructorParameters<typeof DynamicWorkerExecutor>[0]["loader"] });
  return {
    async execute(code: string, providers: ResolvedProvider[]): Promise<ExecuteResult> {
      try {
        const res = await dwe.execute(code, providers);
        return res as ExecuteResult;
      } catch (e) {
        return { result: undefined, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

// LLM for evolution reflections. Uses the agent's configured provider via
// the registry — picks up Codex/OpenRouter/etc. automatically when the user
// has switched providers.
function readStoredModelSpec(agent: AgentHost): string | null {
  // Single canonical path through the typed config store — no raw SQL.
  return createAgentConfigStore(boundSql(agent)).getModel();
}

function createDualPathLLM(agent: AgentHost, actor: ActorRuntimeIdentity): LLM {
  return {
    async *stream() { yield ""; },
    async complete(prompt: string): Promise<string> {
      try {
        const reg = createAgentProviderRegistry({
          env: agent.env,
          userDO: userCredentialSourceFor(agent, actor),
          appTitle: 'Proteus',
          workersAI: { sessionAffinity: agentAffinityKey(agent.name) },
        });
        const model = reg.resolveModel(reg.normalizeSpecSync(readStoredModelSpec(agent)));
        const result = await generateText({
          model, prompt,
          ...effortFor('reflection'),
        });
        return result.text.trim();
      } catch { return "(reflection unavailable)"; }
    },
  };
}

/**
 * The mechanical-work tier (rt.fastLlm): the chat vendor's own small model,
 * for the evolution engine's classification / labelling / short-reflection /
 * extraction calls and sleep-time compression. Resolved at CALL time from the
 * same registry and credentials the chat model uses, so a `fast_model` change
 * or a provider switch takes effect without a redeploy, and no second provider
 * path exists — only a cheaper model id on the one already connected.
 *
 * Returns null when the vendor has no smaller tier, so the runtime leaves
 * `fastLlm` unset and every reader's documented `?? rt.llm` fallback runs.
 */
function createFastLLM(agent: AgentHost, actor: ActorRuntimeIdentity): LLM | undefined {
  const config = createAgentConfigStore(boundSql(agent));
  const registry = createAgentProviderRegistry({
    env: agent.env,
    userDO: userCredentialSourceFor(agent, actor),
    appTitle: 'Proteus (fast)',
    workersAI: { sessionAffinity: agentAffinityKey(agent.name) },
  });
  const selected = () => selectFastModel({
    fastSpec: config.getFastModel(),
    chatSpec: registry.normalizeSpecSync(readStoredModelSpec(agent)),
    providers: registry.registry.list(),
  });
  if (selected().source === 'chat-model') return undefined;
  return {
    async *stream() { yield ""; },
    async complete(prompt: string): Promise<string> {
      try {
        const result = await generateText({
          model: registry.resolveModel(selected().spec), prompt,
          ...effortFor('reflection'),
        });
        return result.text.trim();
      } catch { return "(reflection unavailable)"; }
    },
  };
}

/**
 * Cross-model judge for MCTS branch evaluation (rt.judgeModel). Resolves the
 * operator's review_model (the `review_model` agent_config key) at call time
 * so judging can run on a DIFFERENT model from the explorer — the
 * self-enhancement-bias fix. With no review_model set it now searches the
 * registry for an available model from a different VENDOR family than the
 * chat model, because an unset key used to mean the agent graded itself with
 * itself; same-model judging survives only as the single-vendor fallback (see
 * core's selectJudgeModel). Errors propagate — the evaluator's judge ensemble
 * drops failed samples instead of misreading them as scores.
 */
function createJudgeLLM(agent: AgentHost, actor: ActorRuntimeIdentity): LLM {
  return {
    async *stream() { yield ""; },
    async complete(prompt: string): Promise<string> {
      const config = createAgentConfigStore(boundSql(agent));
      const registry = createAgentProviderRegistry({
        env: agent.env,
        userDO: userCredentialSourceFor(agent, actor),
        appTitle: 'Proteus (judge)',
        workersAI: { sessionAffinity: agentAffinityKey(agent.name) },
      });
      const { spec } = await resolveJudgeModelSelection({
        registry,
        reviewSpec: config.getReviewModel(),
        chatSpec: config.getModel(),
      });
      const result = await generateText({
        model: registry.resolveModel(spec), prompt,
        ...effortFor('judge'),
      });
      return result.text.trim();
    },
  };
}

// ── Schedule: real runFiber from Agent base class ────────────────

function createRealSchedule(agent: AgentHost): Schedule {
  return {
    after: async (ms, fn) => { setTimeout(fn, ms); },
    cron: async () => {},
    fiber: async <T>(name: string, fn: (ctx: FiberCtx) => Promise<T>): Promise<T> => {
      return agent.runFiber(name, async (sdkCtx) => {
        return fn({ stash: sdkCtx.stash, snapshot: sdkCtx.snapshot });
      });
    },
  };
}

// ── Identity ─────────────────────────────────────────────────────

function createIdentity(agent: AgentHost, vfs: CoreVFS, sql: SqlExecutor): Identity {
  return {
    id: agent.ctx.id.toString(),
    name: agent.name,
    scaffold: {
      exists: () => vfs.exists("scaffold/agent.js"),
      read: () => vfs.readFile("scaffold/agent.js", { encoding: "utf8" }) as Promise<string>,
      write: (code: string) => vfs.writeFile("scaffold/agent.js", code),
      version: async () =>
        (sql<{ v: number }>`SELECT COALESCE(MAX(version), 0) as v FROM scaffold_versions`)[0]?.v ?? 0,
    },
  };
}

// ── MCTS branches via real Facets (spawn seam: facet-spawn.ts) ───

function createFacetSpawner(agent: AgentHost, actor: ActorRuntimeIdentity): (branchId: string) => Promise<BranchHandle> {
  return async (branchId: string): Promise<BranchHandle> => {
    try {
      return await spawnBranchFacet(agent, branchId, {
        ownerUserId: actor.ownerUserId(),
        capabilityToken: await actor.capabilityToken(),
      });
    } catch (err) {
      console.warn(`[proteus] subAgent failed for branch ${branchId}: ${(err as Error).message}. Using inline fallback.`);
      return createInlineBranch(agent);
    }
  };
}

function createFacetAborter(agent: AgentHost): (branchId: string) => Promise<void> {
  return async (branchId: string) => { abortExplorationFacet(agent, branchId); };
}

/**
 * Inline branch fallback — used when Facets are unavailable.
 *
 * Storage isolation (lean/Proteus/MCTS/StorageIsolation.lean: branch storage
 * disjoint from the orchestrator's) is enforced STRUCTURALLY by capturing only
 * the LLM config, never the agent reference or its storage. The closure has
 * no path to agent.sql or agent.ctx.storage.
 */
function createInlineBranch(agent: AgentHost): BranchHandle {
  // Capture only env (not agent.sql / agent.ctx.storage) so the branch
  // closure satisfies StorageIsolation. Stored credentials are not available
  // here — with a null UserDO stub the registry's sync default skips the
  // credential-gated workers-ai and uses the env-bound ai-gateway, which
  // needs no credential reads.
  const reg = createAgentProviderRegistry({
    env: agent.env,
    userDO: null,
    appTitle: 'Proteus (inline branch)',
    workersAI: { sessionAffinity: agentAffinityKey(agent.name) },
  });
  const spec = reg.normalizeSpecSync(null);
  const getModel = () => reg.resolveModel(spec);

  return {
    explore: async (history, craftedTools, siblings = []) => {
      // The SAME question the facet asks (core explorePrompt), so a fallback
      // branch is comparable with a facet one — they are scored against each
      // other. This path once asked a materially weaker version of it while
      // claiming to match, which is exactly what the shared prompt prevents.
      const { system, user } = explorePrompt({
        context: formatInheritedContext(history),
        craftedTools,
        siblings,
      });
      const result = await generateText({
        model: getModel(),
        system,
        messages: [{ role: "user" as const, content: user }],
        ...effortFor('mcts_rollout'),
      });
      const text = result.text.trim();
      return { text, codeUsed: extractCodeBlock(text), usage: missionCallUsage(result.usage) };
    },
    // No trace table on this path — the reflection is about the task alone,
    // and the shared prompt drops the attempt heading rather than showing an
    // empty one.
    generateReflection: async (task) => {
      const result = await generateText({
        model: getModel(),
        messages: [{ role: "user" as const, content: reflectionPrompt(task, '') }],
        ...effortFor('reflection'),
      });
      return { text: result.text.trim(), usage: missionCallUsage(result.usage) };
    },
  };
}
