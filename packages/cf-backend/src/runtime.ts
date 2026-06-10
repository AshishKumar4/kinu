/**
 * CF runtime adapter — bridges Think's DO context to core's AgentRuntime.
 *
 * Uses agent-utils for storage (pure DO SQLite — no R2, no @cloudflare/shell):
 *   VFS      → SqliteFS (vfs_files table with chunked storage)
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
  VFS as CoreVFS, Memory, Executor, LLM, Schedule, Identity,
  SqlExecutor as CoreSqlExecutor, RawSqlExec,
  ExecuteResult, ResolvedProvider,
  CraftStore as CoreCraftStore, CraftedTool as CoreCraftedTool,
  FiberCtx, ExecutionRouter,
} from "@proteus/core";
import {
  DefaultExecutionRouter, createInlineExecutor,
  createSandboxExecutor, createSSHTunnelExecutor, type DeviceTransport,
  NO_DEVICE_CONNECTED, isDeviceNotConnectedError,
  createNimbusExecutor, type NimbusSandboxHandle,
  createCloudflareVectorStore, createWorkersAIEmbedder, createNoopVectorStore,
  effortFor,
  createAgentConfigStore,
  extractJsonObject,
  jsonObjectOnlyInstruction,
  type VectorStore, type VectorizeIndex,
} from "@proteus/core";
import type { SandboxHandle } from "@proteus/core";
import { getSandbox } from "@cloudflare/sandbox";
import { Nimbus } from "@nimbus-sh/sdk";
import { SqliteFS } from "@proteus/agent-utils/vfs";
import { MemoryStore } from "@proteus/agent-utils/memory";
import { CraftStore as AgentUtilsCraftStore } from "@proteus/agent-utils/stores";
import { createShell } from "@proteus/agent-utils/shell";
import type { SqlExecutor } from "@proteus/agent-utils";
import { generateText } from "ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { Think } from "@cloudflare/think";
import { ExplorationAgent } from "./exploration.js";
import { createAgentProviderRegistry, type AgentProviderRegistry } from "./providers/agent-registry.js";
import { agentAffinityKey } from "./providers/workers-ai.js";
import type { UserDO } from "./user/user-do.js";
import {
  nimbusSandboxConfig,
  nimbusSandboxIdForAgent,
  nimbusSubjectForAgent,
  nimbusTenantForUser,
} from "./nimbus-route.js";

/** How long the laptop executor's cached device-connected flag stays fresh
 *  before isConnected() kicks a background re-check against the user hub. */
const DEVICE_CONNECTED_TTL_MS = 5_000;

/**
 * The agent surface these runtime builders need. `env`/`ctx` are `protected`
 * on the DurableObject base (not reachable by these free functions), but the
 * runtime is conceptually an extension of the agent and legitimately needs
 * them. The orchestrator (a subclass that DOES have access) passes `this`
 * cast to this view — so the access is sound, just opened to these helpers.
 */
type AgentHost = Think<Env> & {
  readonly env: Env;
  readonly ctx: DurableObjectState;
};

/** Read owner_user_id from the orchestrator's agent_identity. Empty/missing -> null. */
function readOwnerUserId(agent: AgentHost): string | null {
  try {
    const rows = agent.sql<{ owner_user_id: string }>`SELECT owner_user_id FROM agent_identity LIMIT 1`;
    const v = rows[0]?.owner_user_id;
    return v && v !== '' ? v : null;
  } catch { return null; }
}

function userDOStubFor(agent: AgentHost): DurableObjectStub<UserDO> | null {
  const userId = readOwnerUserId(agent);
  if (!userId) return null;
  return agent.env.UserDO.get(agent.env.UserDO.idFromName(userId)) as DurableObjectStub<UserDO>;
}

/** Extended runtime that exposes the raw SqliteFS for shell emulation, the
 *  SSH executor for tunnel socket management, and the Vectorize-backed
 *  vector store for semantic memory. */
export type CFRuntime = AgentRuntime & {
  sqliteFS: SqliteFS;
  sshExecutor: ReturnType<typeof createSSHTunnelExecutor>;
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
}

/**
 * Build a full AgentRuntime from a Think agent's DO context.
 */
export function createCFRuntime(agent: AgentHost, hooks: CFRuntimeHooks = {}): CFRuntime {
  const sql = agent.sql.bind(agent) as unknown as SqlExecutor;
  const execRaw: RawSqlExec = (ddl: string) => agent.ctx.storage.sql.exec(ddl);

  // SqliteFS from agent-utils — pure DO SQLite, no R2
  const sqliteFS = new SqliteFS(sql);
  sqliteFS.init();

  // MemoryStore from agent-utils — FTS5-indexed search
  const memoryStore = new MemoryStore(sqliteFS, sql);
  memoryStore.ensureSchema();

  // CraftStore from agent-utils — FTS5-indexed tool storage
  const craftStoreImpl = new AgentUtilsCraftStore(sql);
  craftStoreImpl.ensureSchema();

  // Adapt SqliteFS to core's VFS interface (SqliteFS has a superset of methods)
  const vfs = adaptVFS(sqliteFS);

  // Adapt MemoryStore to core's Memory interface
  const memory = adaptMemory(memoryStore);

  // Adapt CraftStore to core's CraftStore interface
  const craftStore = adaptCraftStore(craftStoreImpl);

  const envForExec = agent.env as Env & Record<string, unknown>;
  if (!envForExec.LOADER) {
    throw new Error("CF runtime requires env.LOADER binding (worker_loaders in wrangler.jsonc)");
  }
  const executor = createExecutor(envForExec.LOADER);
  const llm = createDualPathLLM(agent);
  const schedule = createRealSchedule(agent);
  const identity = createIdentity(agent, vfs, sql as unknown as CoreSqlExecutor);

  // Execution router — manages codemode providers (workspace, nimbus, sandbox, laptop)
  const shell = createShell(sqliteFS);
  const executionRouter: ExecutionRouter = new DefaultExecutionRouter();
  executionRouter.register(createInlineExecutor({
    vfs, memory, craftStore, shell,
    // sql is used by workspace.listTools() to look up EMA craft_scores.
    // Cast because adaptVFS returns core's SqlExecutor shape.
    sql: sql as unknown as import("@proteus/core").SqlExecutor,
    // Optional eager notification; PreambleCraftedExecutor live-reads CraftStore.
    onToolRegistered: hooks.onToolRegistered,
  }));
  // Register Sandbox executor — Proteus's primary remote exec surface.
  // Backed by @cloudflare/sandbox: one Linux container per agent, keyed
  // by the agent's stable name. `PREVIEW_HOSTNAME` is the public host for
  // path-style preview URLs (see preview-proxy.ts); `sandboxId` is the
  // stable DO key so URLs round-trip back to the correct container.
  const env = agent.env as Env & Record<string, unknown>;
  const previewHostname = typeof env.PREVIEW_HOSTNAME === "string" && env.PREVIEW_HOSTNAME.length > 0
    ? env.PREVIEW_HOSTNAME
    : undefined;
  const sandboxId = `proteus-${agent.name}`;
  let sandboxHandle: SandboxHandle | null = null;
  if (env.Sandbox && previewHostname) {
    try {
      const rawHandle = getSandbox(
        env.Sandbox as Parameters<typeof getSandbox>[0],
        sandboxId,
        { normalizeId: true },
      ) as unknown as SandboxHandle;
      const configStore = createAgentConfigStore(sql as unknown as CoreSqlExecutor);
      const handle = createRestoringSandboxHandle(rawHandle, configStore);
      sandboxHandle = handle;
      executionRouter.register(createSandboxExecutor(handle, previewHostname, sandboxId));
      console.log(`[proteus] SandboxExecutor registered (host=${previewHostname} id=${sandboxId})`);
    } catch (err) {
      console.warn("[proteus] Failed to register SandboxExecutor:", (err as Error).message);
      executionRouter.register(createSandboxExecutor());
    }
  } else {
    if (!previewHostname) console.warn("[proteus] PREVIEW_HOSTNAME not set — Sandbox executor running in stub mode");
    executionRouter.register(createSandboxExecutor());
  }

  // Register Nimbus — Proteus's built-in lightweight sandbox. This uses the
  // official SDK against the local NIMBUS_SESSION binding, so there are no
  // endpoint/token secrets. The handle is lazy: no session is touched until
  // the agent actually calls nimbus.*.
  if (env.NIMBUS_SESSION) {
    try {
      executionRouter.register(createNimbusExecutor({
        box: createAgentNimbusHandle(agent),
      }));
      console.log('[proteus] NimbusExecutor registered (NIMBUS_SESSION binding)');
    } catch (err) {
      console.warn('[proteus] Failed to register NimbusExecutor:', (err as Error).message);
    }
  } else {
    executionRouter.register(createNimbusExecutor());
  }

  // Register the laptop executor. The device socket lives on the user's UserDO
  // (the user-level hub), so this executor FORWARDS each JSON-RPC call there —
  // one connected device serves all of the user's agents. `isConnected()` is
  // sync + hot (it gates per-turn tool exposure), so it serves a cached flag
  // refreshed from the hub in the background once it goes stale — a device
  // connecting AFTER this runtime was built becomes visible within the TTL,
  // without a DO restart. Actual calls stay authoritative either way: the hub
  // rejects when no device is connected, and each call's outcome re-seeds the
  // flag.
  let deviceConnected = false;
  let deviceCheckedAt = 0;
  let deviceCheck: Promise<void> | null = null;
  const refreshDeviceConnected = (): void => {
    if (deviceCheck || Date.now() - deviceCheckedAt < DEVICE_CONNECTED_TTL_MS) return;
    const stub = userDOStubFor(agent);
    if (!stub) { deviceConnected = false; deviceCheckedAt = Date.now(); return; }
    deviceCheck = (async () => {
      try { deviceConnected = await stub.isDeviceConnected(); }
      catch { /* transient hub error — keep the last value */ }
      finally { deviceCheckedAt = Date.now(); deviceCheck = null; }
    })();
  };
  const deviceTransport: DeviceTransport = {
    isConnected: () => { refreshDeviceConnected(); return deviceConnected; },
    rpc: async (method, params) => {
      const stub = userDOStubFor(agent);
      if (!stub) { deviceConnected = false; deviceCheckedAt = Date.now(); throw new Error(NO_DEVICE_CONNECTED); }
      try {
        const cwd = typeof (agent as unknown as { getCliCwdForDevice?: () => string | null }).getCliCwdForDevice === 'function'
          ? (agent as unknown as { getCliCwdForDevice: () => string | null }).getCliCwdForDevice()
          : null;
        const effectiveParams = method === 'exec' && cwd
          ? [`cd ${shellQuote(cwd)} && ${String(params[0] ?? '')}`]
          : params;
        // Pass the agent's name so the hub can enforce per-agent consent.
        const result = await stub.deviceRpc(method, effectiveParams, {
          agentName: agent.name,
        });
        deviceConnected = true;
        deviceCheckedAt = Date.now();
        return result;
      } catch (err) {
        if (isDeviceNotConnectedError(err)) {
          deviceConnected = false;
          deviceCheckedAt = Date.now();
        }
        throw err;
      }
    },
  };
  refreshDeviceConnected();
  const sshExecutor = createSSHTunnelExecutor(deviceTransport);
  executionRouter.register(sshExecutor);

  // Vectorize-backed semantic memory. Only constructs when both
  // env.AI (Workers AI binding) and env.MEMORY_VECTORS (Vectorize index
  // binding) are configured. Otherwise falls back to a noop that lets
  // hybrid search degrade to FTS5-only.
  const aiBinding = (agent.env as Env & Record<string, unknown>).AI;
  const vectorizeBinding = (agent.env as Env & Record<string, unknown>).MEMORY_VECTORS;
  let vectorStore: VectorStore;
  if (aiBinding && typeof aiBinding !== 'string' && vectorizeBinding) {
    try {
      const embedder = createWorkersAIEmbedder({
        aiBinding: aiBinding as Parameters<typeof createWorkersAIEmbedder>[0]['aiBinding'],
        model: '@cf/baai/bge-small-en-v1.5',
        dimensions: 384,
      });
      vectorStore = createCloudflareVectorStore({
        index: vectorizeBinding as VectorizeIndex,
        embedder,
      });
      console.log('[proteus] VectorStore (Cloudflare Vectorize) registered');
    } catch (err) {
      console.warn('[proteus] VectorStore construction failed; falling back to noop:', (err as Error).message);
      vectorStore = createNoopVectorStore();
    }
  } else {
    vectorStore = createNoopVectorStore();
  }

  return {
    storage: { vfs, sql: sql as unknown as CoreSqlExecutor, execRaw },
    memory, executor, llm, schedule, identity, craftStore,
    spawnBranch: createFacetSpawner(agent),
    abortBranch: createFacetAborter(agent),
    executionRouter,
    shell,
    sqliteFS,
    sshExecutor,
    vectorStore,
    sandboxHandle,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function publicOriginForNimbus(env: Env & Record<string, unknown>): string {
  if (typeof env.CLI_PUBLIC_ORIGIN === "string" && env.CLI_PUBLIC_ORIGIN.length > 0) {
    return env.CLI_PUBLIC_ORIGIN.replace(/\/+$/, "");
  }
  if (typeof env.PREVIEW_HOSTNAME === "string" && env.PREVIEW_HOSTNAME.length > 0) {
    return `https://${env.PREVIEW_HOSTNAME}`;
  }
  return "https://proteus.local";
}

function createAgentNimbusHandle(agent: AgentHost): NimbusSandboxHandle {
  let cachedKey = "";
  let cachedBox: any = null;

  const current = () => {
    const env = agent.env as Env & Record<string, unknown>;
    const tenant = nimbusTenantForUser(readOwnerUserId(agent));
    const subject = nimbusSubjectForAgent(agent.name);
    const sessionId = nimbusSandboxIdForAgent(agent.name);
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
    readFile: (path) => before(() => handle.readFile(path)),
    writeFile: (path, content) => before(() => handle.writeFile(path, content)),
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

function adaptVFS(fs: SqliteFS): CoreVFS {
  return {
    // SqliteFS narrows encoding to the "utf8" literal; CoreVFS allows any
    // string. Only "utf8" selects text mode — anything else is binary.
    readFile: (path, opts) => fs.readFile(path, opts?.encoding === 'utf8' ? { encoding: 'utf8' } : undefined),
    writeFile: (path, data) => fs.writeFile(path, data),
    readdir: (path) => fs.readdir(path),
    async stat(path) {
      try {
        const s = await fs.stat(path);
        return { size: s.size, mtime: s.mtimeMs, isDir: s.type === "dir" };
      } catch { return null; }
    },
    unlink: (path) => fs.unlink(path),
    mkdir: (path, opts) => fs.mkdir(path, opts),
    exists: (path) => fs.exists(path),
  };
}

function adaptMemory(store: MemoryStore): Memory {
  return {
    write: (path, content) => store.writeFile(path, content),
    append: (path, content) => store.appendToFile(path, content),
    async index(path) {
      const content = await store.readFile(path);
      if (content) await store.indexFile(path, content);
    },
    search: (query, limit) => Promise.resolve(store.search(query, limit)),
    read: (path) => store.readFile(path),
  };
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
  return createAgentConfigStore(
    agent.sql.bind(agent) as unknown as CoreSqlExecutor,
  ).getModel();
}

function createDualPathLLM(agent: AgentHost): LLM {
  return {
    async *stream() { yield ""; },
    async complete(prompt: string): Promise<string> {
      try {
        const reg = createAgentProviderRegistry({
          env: agent.env,
          userDOStub: userDOStubFor(agent),
          appTitle: 'Proteus',
          workersAI: { sessionAffinity: agentAffinityKey(agent.name) },
        });
        const model = reg.resolveModel(reg.normalizeSpecSync(readStoredModelSpec(agent)));
        const result = await generateText({
          model, prompt, maxOutputTokens: 512,
          ...effortFor('reflection'),
        });
        return result.text.trim();
      } catch { return "(reflection unavailable)"; }
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

function createIdentity(agent: AgentHost, vfs: CoreVFS, sql: CoreSqlExecutor): Identity {
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

// ── MCTS branches via real Facets (subAgent) ─────────────────────

function createFacetSpawner(agent: AgentHost): (branchId: string) => Promise<BranchHandle> {
  return async (branchId: string): Promise<BranchHandle> => {
    try {
      const stub = await agent.subAgent(ExplorationAgent, branchId);
      const owner = readOwnerUserId(agent);
      if (owner) await stub.setOwner(owner);
      return {
        explore: async (history, tools) => stub.explore(history, tools),
        evaluate: async (task) => stub.evaluate(task),
        generateReflection: async (task) => stub.generateReflection(task),
      };
    } catch (err) {
      console.warn(`[proteus] subAgent failed for branch ${branchId}: ${(err as Error).message}. Using inline fallback.`);
      return createInlineBranch(agent);
    }
  };
}

function createFacetAborter(agent: AgentHost): (branchId: string) => Promise<void> {
  return async (branchId: string) => {
    try { agent.abortSubAgent(ExplorationAgent, branchId); } catch {}
  };
}

/**
 * Inline branch fallback — used when Facets are unavailable.
 *
 * Formal spec: DistributedModel.lean requires StorageIsolation (branch storageIds
 * disjoint from orchestrator storageId). The inline branch enforces this
 * STRUCTURALLY by capturing only the LLM config, never the agent reference
 * or its storage. The closure has no path to agent.sql or agent.ctx.storage.
 */
function createInlineBranch(agent: AgentHost): BranchHandle {
  // Capture only env (not agent.sql / agent.ctx.storage) so the branch
  // closure satisfies StorageIsolation. Stored credentials are not available
  // here — with a null UserDO stub the registry's sync default skips the
  // credential-gated workers-ai and uses the env-bound ai-gateway, which
  // needs no credential reads.
  const reg = createAgentProviderRegistry({
    env: agent.env,
    userDOStub: null,
    appTitle: 'Proteus (inline branch)',
    workersAI: { sessionAffinity: agentAffinityKey(agent.name) },
  });
  const spec = reg.normalizeSpecSync(null);
  const getModel = () => reg.resolveModel(spec);

  return {
    explore: async (history, _tools) => {
      const context = history.map((m: { role: string; content: string }) =>
        `${m.role}: ${m.content}`).join("\n").slice(-800);
      const result = await generateText({
        model: getModel(),
        system: "You are an expert exploring one approach to solve a task.\nIf your approach involves code, include it in a ```js code block.",
        messages: [{ role: "user" as const, content: `Context:\n${context}\n\nPropose ONE approach. Include code if applicable.` }],
        maxOutputTokens: 512,
      });
      const text = result.text.trim();
      const codeMatch = text.match(/```(?:js|javascript|typescript|ts)?\n([\s\S]*?)```/);
      return { text, codeUsed: codeMatch?.[1]?.trim() ?? null };
    },
    evaluate: async (task) => {
      const result = await generateText({
        model: getModel(),
        messages: [{
          role: "user" as const,
          content: `Rate this approach (0-1): ${task.slice(0, 500)}\nJSON shape: {"score": <float>}\n${jsonObjectOnlyInstruction()}`,
        }],
        maxOutputTokens: 100,
      });
      try {
        const parsed = extractJsonObject(result.text) as { score?: unknown };
        const score = Number(parsed.score);
        return Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0;
      } catch { return 0; }
    },
    generateReflection: async (task) => {
      const result = await generateText({
        model: getModel(),
        messages: [{ role: "user" as const, content: `What went wrong? ${task.slice(0, 500)}\nOne sentence.` }],
        maxOutputTokens: 200,
      });
      return result.text.trim();
    },
  };
}
