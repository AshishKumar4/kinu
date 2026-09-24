/**
 * CF runtime adapter: bridges the Agents DO context to core's AgentRuntime. One Durable Object per
 * workspace; VFS, shell, memory and craft stores all live in the owning actor's `ctx.storage.sql`.
 */

import type {
  AgentRuntime, ActorHandle, BranchHandle,
  VFS as CoreVFS, Executor, LLM, Schedule, Identity,
  SqlExecutor, SqlValue, RawSqlExec,
  ExecuteResult, ResolvedProvider,
  FiberCtx, ExecutionRouter,
  TurnAccumulator,
  DeferredApprovalChannel,
  WriteObserver,
  ModelCallSink, SpendSource, ResolvedTurnProfile,
  SlateCallResult, SlateOperation,
  ActorClaimStore, ChildContextResolver, ContextEventRecorder,
} from "@kinu.run/core";
import {
  nimbusSessionFiles, nimbusSessionShell,
  observeWrites,
  type WorkspaceVFS,
  DefaultExecutionRouter, createNimbusWorkspaceExecutor,
  withMountTable, standardMounts, contextMount, skillsMount,
  sharedDriveMount, SHARED_DRIVE_UNCLAIMED, SHARED_DRIVE_UNBOUND, type MossaicVfs,
  withApprovalGatedShell, createInheritedApprovalPolicy, holdsGrant,
  type ShellApprovalPolicy, type ShellApprovalMode, type ApprovalGrant,
  type EgressSecretBinding,
  createSandboxExecutor, createDeviceTunnelExecutor, type DeviceTransport,
  type NimbusSandboxHandle,
  createCloudflareVectorStore, createWorkersAIEmbedder, createNoopVectorStore,
  decodeJsonValue,
  initAgentConfigTable, initActorTables,
  parseModelSpec, reasoningEffortOptions, createRoutedModelLane,
  createScaffoldSurface,
  type FixedTierSource,
  type VectorStore,
} from "@kinu.run/core";
import type { DeviceFileScope, SandboxHandle } from "@kinu.run/core";
import { withHostedNodeExecution, REAL_CLOCK } from '@kinu.run/core';
import type { HostedNodeHome } from '@kinu.run/core';

export { withHostedNodeExecution, type HostedNodeHome } from '@kinu.run/core';

import { diagnostics, KinuError, renderThrownChain, toKinuError } from "@kinu.run/core/obs";
import { kinuEgressParams } from "./egress/configure";
import { driveBound, tenantDrive } from "./drive/tenant";
import { adaptCloudflareSandbox, openSandbox } from "./sandbox-exec-lane";
import { previewHostSuffix } from "@kinu.run/core";
import { SANDBOX_TRANSPORT, sandboxIdForWorkspace } from "@kinu.run/core";
import { sandboxPreviewExposures } from "@kinu.run/core";
import { MemoryStore } from "@kinu.run/agent-utils/memory";
import { CraftStore as AgentUtilsCraftStore, craftStoreView } from "@kinu.run/agent-utils/stores";
import { generateText, type LanguageModelUsage } from "ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { Agent } from "agents";
import {
  createHubDeviceTransport,
  type DeviceHubClient,
  type HubDeviceTransportOpts,
} from "@kinu.run/core";
import {
  createAgentProviderRegistry,
  type AgentProviderRegistry,
  type UserCredentialClient,
  type UserCredentialSource,
} from "./providers/agent-registry";
import { ownerCaller, type UserCaller } from "@kinu.run/core";
import { adaptMemory, backfillMemoryVectors } from "@kinu.run/core";
import {
  agentAffinityKey, normalizeUsage,
} from "@kinu.run/core";
import { nimbusPreviewConfigured } from "./nimbus-route";

/**
 * Every logical actor in a workspace is built over the root object's `name`, `sql` and `runFiber`; runtimes
 * differ only by `ActorRuntimeIdentity`. The root passes `this` cast to this view to open protected `env`/`ctx`.
 */
type AgentHost = Pick<Agent<Env>, 'name' | 'sql' | 'runFiber'>;

export interface CFRuntimeAccess {
  readonly env: Env;
  readonly ctx: DurableObjectState;
  /** One box per workspace: a child composing its own gets a second, empty filesystem
     *  (tests/unit-head-fork.test.ts). Actors are separated by `shellId` and credential. */
  workspaceBox(shellId: string): NimbusSandboxHandle;
  /** Absent for facets without a budget ledger; the `workspace` provider then uses a private ledger. */
  readonly acc?: () => Pick<TurnAccumulator, 'files' | 'context'>;
  getCliCwdForDevice?(): string | null;
  getCheckpointMetaForDevice?(): { turnId: string; sessionId: string } | null;
}

/** A method, so the SDK's scalar-only `sql` satisfies it while `SqlExecutor` also admits ArrayBuffer. */
interface AgentSqlSource {
  sql<T = unknown>(query: TemplateStringsArray, ...values: SqlValue[]): T[];
}

export function bindAgentSql(agent: AgentSqlSource): SqlExecutor {
  return agent.sql.bind(agent);
}

/** Which logical actor this runtime belongs to; one Durable Object hosts all of them. */
export interface ActorRuntimeIdentity {
  actor: ActorHandle;
  /** Stated, never inferred: every hosted actor answers to the root's agent `name`, so a name test would
     *  hand a subordinate the root's shell-approval authority. */
  rootActor: boolean;
  /** Resolved per call, never cached, so a use before owner claim can't bake in null. */
  ownerUserId(): string | null;
  /** The same for every actor in one workspace; a child naming itself would derive a second, empty
     *  filesystem (tests/unit-head-fork.test.ts). */
  workspaceName: string;
  /** Distinct actors share files, processes and ports without sharing cwd or exported env. */
  shellId: string;
  scaffoldPath: string;
  /** One token per workspace: a hosted actor is never attenuated more widely than the workspace. */
  capabilityToken(): string | null;
}

interface RuntimeUserDOClient extends UserCredentialClient, DeviceHubClient {
  getDeviceFileView(caller: UserCaller, agentName: string, device?: string): Promise<{ scope: DeviceFileScope }>;
}

interface RuntimeUserDONamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): RuntimeUserDOClient;
}

function userDOStubFor(env: Env, actor: ActorRuntimeIdentity): RuntimeUserDOClient | null {
  const userId = actor.ownerUserId();

  if (!userId) return null;
  // Narrowed, never copied: a JSRPC stub's methods live behind a Proxy, so `Object.assign` yields `{}`.
  const namespace: RuntimeUserDONamespace = env.UserDO;

  return namespace.get(namespace.idFromName(userId));
}

/** An unreadable vault rejects: the sandbox handle memoizes this configuration, so an empty answer would
 *  strip every injectable secret for the handle's life. */
async function listOwnerEgressVault(
  env: Env, actor: ActorRuntimeIdentity,
): Promise<EgressSecretBinding[]> {
  const userId = actor.ownerUserId();

  if (!userId) return [];
  // Used, never copied (see `userDOStubFor`).
  const vault: EgressVaultClient = env.UserDO.get(env.UserDO.idFromName(userId));

  return [...await vault.listEgressSecrets(await ownerCaller(env))];
}

interface EgressVaultClient {
  listEgressSecrets(caller: UserCaller): Promise<readonly EgressSecretBinding[]>;
}

async function userCallerFor(actor: ActorRuntimeIdentity): Promise<UserCaller> {
  const workspaceToken = actor.capabilityToken();

  if (!workspaceToken) throw new Error('This workspace has not been issued a capability token yet.');

  return { workspaceToken };
}

/** Both methods are on `ORCHESTRATOR_RPC_SURFACE` via `AGENT_RPC_ACCESS`; fetched together in one round trip. */
async function fetchRootApprovalPolicy(
  env: Env, workspaceName: string,
): Promise<{ mode: ShellApprovalMode; grants: readonly ApprovalGrant[] }> {
  // Used, not copied. unit-facet-grant-inheritance.test.ts asserts both names are on the surface.
  const root: RootApprovalClient = env.OrchestratorAgent.get(
    env.OrchestratorAgent.idFromName(workspaceName),
  );

  const [mode, grants] = await Promise.all([
    root.getShellApprovalMode(), root.getShellApprovalGrants(),
  ]);

  return { mode: mode.mode, grants: grants.grants };
}

interface RootApprovalClient {
  getShellApprovalMode(): Promise<{ mode: ShellApprovalMode }>;
  getShellApprovalGrants(): Promise<{ grants: readonly ApprovalGrant[] }>;
}

function userCredentialSourceFor(env: Env, actor: ActorRuntimeIdentity): UserCredentialSource | null {
  const stub = userDOStubFor(env, actor);

  return stub ? { stub, caller: () => userCallerFor(actor) } : null;
}

export type CFRuntime = AgentRuntime & {
  /** Also what the parent-file RPC serves a fork, so a fork reads exactly its parent's bytes. */
  localVfs: WorkspaceVFS;
  /** `refreshStatus()` is awaited at turn start. */
  deviceTransport: DeviceTransport;
  vectorStore: import("@kinu.run/core").VectorStore;
  startupWork: Promise<void>;
  sandboxHandle: SandboxHandle | null;
};

/** Every runtime this backend builds carries a vector store (noop when unbound). */
export function isCFRuntime(runtime: AgentRuntime): runtime is CFRuntime {
  return 'vectorStore' in runtime;
}

export interface CFRuntimeHooks {
  /** A thunk read at exec time: resolving during construction would re-enter the caller's lazy runtime
     *  getter. Undefined (head, subordinate) means no queue, so 'strict' refuses. */
  deferrals?: () => DeferredApprovalChannel | undefined;
  slate?: (operation: SlateOperation) => Promise<SlateCallResult>;
  workspaceObserver?: WriteObserver;
  /** Where non-turn model seams (judge, fast tier, reflection, embedder) report cost; turn spend arrives
     *  as `step_finish`. Optional: unattributed spend shows in the coverage fraction. */
  reportModelCall?: ModelCallSink;
  resolveProfile?: () => Promise<ResolvedTurnProfile>;
  /** The actor's uid on both planes, or neither: split credentials measured `EACCES` on its own home
     *  and could write a sibling's. */
  workspaceExecution?: HostedNodeHome;
  /** `children` is opened under the actor host's directory authority, never by a caller knowing an id. */
  contextPlane?: {
    readonly actorId: string;
    claims(): ActorClaimStore;
    /** Null until the `context_edit` run-event variant exists; not a stub. */
    events(): ContextEventRecorder | null;
    readonly children: ChildContextResolver;
  };
  /** Omitted leaves `spawnBranch`/`abortBranch` refusing, since `AgentRuntime` requires them. */
  branches?: {
    spawn(branchId: string): Promise<BranchHandle>;
    abort(branchId: string): Promise<void>;
  };
}

export function createCFRuntime(
  agent: AgentHost,
  access: CFRuntimeAccess,
  actor: ActorRuntimeIdentity,
  hooks: CFRuntimeHooks = {},
): CFRuntime {
  const sql = bindAgentSql(agent);
  const execRaw: RawSqlExec = (ddl: string) => access.ctx.storage.sql.exec(ddl);

  const env = access.env;
  const workspaceBox = access.workspaceBox(actor.shellId);

  const executionBox = hooks.workspaceExecution
    ? withHostedNodeExecution(workspaceBox, hooks.workspaceExecution)
    : workspaceBox;

  // Workspace state belongs to the session user: a facet's uid could not create entries under `.kinu`.
  const originVfs = nimbusSessionFiles(workspaceBox);

  // Both of the actor's planes or neither (see `workspaceExecution`). This unmounted tree keeps foreign
  // bytes out of memory and agent-state snapshots.
  const baseWorkspaceVfs = hooks.workspaceExecution
    ? nimbusSessionFiles(workspaceBox, hooks.workspaceExecution.cred)
    : originVfs;

  const observedWorkspaceVfs = hooks.workspaceObserver
    ? observeWrites(baseWorkspaceVfs, hooks.workspaceObserver)
    : baseWorkspaceVfs;

  const memoryStore = new MemoryStore(originVfs, sql);
  memoryStore.ensureSchema();

  // Built before the memory adapter so writes embed.
  const vectorStore = buildVectorStore(env, actor, hooks.reportModelCall);
  // An exploration facet's own storage is untouched by `initWorkspaceSchema`; without this every head
  // dies on `no such table: actor_config`.
  initAgentConfigTable(execRaw);
  // The rest of a full-loop actor's own tables (e.g. `crafted_tools`, `evolution_events`), for the same reason.
  initActorTables(execRaw, sql);
  const memoryConfig = actor.actor.config;

  const craftStoreImpl = new AgentUtilsCraftStore(sql);
  craftStoreImpl.ensureSchema();

  const memory = adaptMemory(memoryStore, originVfs, vectorStore, memoryConfig);

  const craftStore = craftStoreView(craftStoreImpl);

  const envForExec = env;

  if (!envForExec.LOADER) {
    throw new Error("CF runtime requires env.LOADER binding (worker_loaders in wrangler.jsonc)");
  }

  const executor = createExecutor(envForExec.LOADER);

  const profileLane = (source: FixedTierSource): LLM | undefined => createProfileLaneLLM({
    agent, env, actor, resolveProfile: hooks.resolveProfile, source, report: hooks.reportModelCall,
  });

  // The one required lane: `AgentRuntime.llm` is not optional.
  const llm: LLM = profileLane('reflection') ?? {
    async *stream() { yield ""; },
    async complete(): Promise<string> {
      throw new Error('reflection model lane has no active profile');
    },
  };

  const schedule = createRealSchedule(agent);
  const identity = createIdentity(actor.actor, originVfs, sql, actor.scaffoldPath);

  // Main vs hosted is stated (`rootActor`), never derived from the name. Grants are only written to
  // main's rows, so a hosted actor inherits the root's answers intersected with its own narrowing, with no
  // `remember`: never a superset. `deferrals` parks a 'gate' decision under 'strict' on the owner.
  const isRootActor = actor.rootActor;

  const approvalPolicy: ShellApprovalPolicy = isRootActor
    ? {
      mode: () => memoryConfig.getShellApprovalMode(),
      granted: (grant) => holdsGrant(memoryConfig.getShellApprovalGrants(), grant),
      requestApproval: null,
      get deferrals() { return hooks.deferrals?.(); },
    }
    : createInheritedApprovalPolicy({
      fetchRoot: () => fetchRootApprovalPolicy(env, actor.workspaceName),
      ownGrants: () => memoryConfig.getShellApprovalGrants(),
    });

  const shell = withApprovalGatedShell(nimbusSessionShell(executionBox), approvalPolicy);
  const executionRouter: ExecutionRouter = new DefaultExecutionRouter(approvalPolicy);
  // State services keep `baseWorkspaceVfs` and never index foreign bytes. The context mount is last:
  // the only per-actor entry.
  const mounts = [...standardMounts((name) => executionRouter.getProvider(name)), skillsMount((): CoreVFS => agentFileVfs)];

  // `/shared`: the owner's Drive, resolved at every call, never captured, so a later claim mounts it.
  let drive: { tenant: string; files: MossaicVfs } | null = null;

  mounts.push(sharedDriveMount(
    () => {
      const tenant = actor.ownerUserId();

      if (tenant === null) return null;

      if (drive === null || drive.tenant !== tenant) {
        const files = tenantDrive(env, tenant);

        if (files === null) return null;
        drive = { tenant, files };
      }

      return drive.files;
    },
    () => (driveBound(env) ? SHARED_DRIVE_UNCLAIMED : SHARED_DRIVE_UNBOUND),
  ));
  const plane = hooks.contextPlane;

  if (plane) {
    mounts.push(contextMount({
      // A thunk: a mount must not capture a store bound to a since-retired identity.
      stores: () => ({ actorId: plane.actorId, claims: plane.claims(), events: plane.events() }),
      children: plane.children,
    }));
  }

  const agentFileVfs = withMountTable(observedWorkspaceVfs, mounts);
  // The shell this actor runs as serves its file tool's mount points.
  workspaceBox.mountTable?.(agentFileVfs, hooks.workspaceExecution?.cred);
  executionRouter.register(createNimbusWorkspaceExecutor({
    box: executionBox,
    // Declared exactly when NIMBUS_RUNTIME_CACHE is bound: without it there is nothing to install.
    runtimeCatalog: env.NIMBUS_RUNTIME_CACHE !== undefined,
    inboundNetwork: nimbusPreviewConfigured(env),
    inline: {
      vfs: agentFileVfs, memory, craftStore, shell,
      sql,
      ledger: () => access.acc?.().files,
      budget: () => access.acc?.().context,
      slate: hooks.slate,
    },
  }));
  const previewSuffix = previewHostSuffix(env) ?? undefined;
  const sandboxId = sandboxIdForWorkspace(actor.workspaceName);
  let sandboxHandle: SandboxHandle | null = null;

  if (env.Sandbox) {
    try {
      const sdk = openSandbox(env.Sandbox, sandboxId, { normalizeId: true });

      // Egress is configured before the container runs anything, not in `onStart` (too late); until then
      // the container has no network, so it fails closed. Only the owning workspace configures.
      const handle = adaptCloudflareSandbox(sdk, async () => {
        const userId = actor.ownerUserId();

        if (!userId) return;
        await sdk.configureEgress(kinuEgressParams({
          workspaceName: actor.workspaceName,
          ownerUserId: userId,
          vault: await listOwnerEgressVault(env, actor),
          grants: memoryConfig.getShellApprovalGrants(),
        }));
      },
      // The edge proves a preview hostname from `AUTH_KV` without creating the per-name DO.
      env.AUTH_KV ? sandboxPreviewExposures(env.AUTH_KV, sandboxId) : null);

      sandboxHandle = handle;
      // No restore wrapper: KinuSandbox.onStart restores inside blockConcurrencyWhile.
      executionRouter.register(createSandboxExecutor(handle, previewSuffix));
      diagnostics.event('sandbox.executor_registered', {
        sandboxId,
        transport: SANDBOX_TRANSPORT,
        previews: previewSuffix ?? '',
      });
    } catch (err) {
      diagnostics.failure('sandbox.executor_registration_failed', toKinuError({
        doing: 'registering the sandbox executor',
        cause: err,
        otherwise: 'unavailable',
      }), { sandboxId });
      executionRouter.register(createSandboxExecutor());
    }
  } else {
    executionRouter.register(createSandboxExecutor());
  }

  // The device socket lives on the user's UserDO, so each call is forwarded there.
  const cliCwdForDevice = () => access.getCliCwdForDevice?.() ?? null;

  const deviceTransportOptions: HubDeviceTransportOpts = {
    hub: () => userDOStubFor(env, actor),
    caller: () => userCallerFor(actor),
    agentName: actor.workspaceName,
    cliCwd: cliCwdForDevice,
    checkpointMeta: () => access.getCheckpointMetaForDevice?.() ?? null,
    clock: REAL_CLOCK,
  };

  const deviceTransport = createHubDeviceTransport(deviceTransportOptions);

  const startupWork: Promise<void> = (async () => {
    await Promise.all([
      (async (): Promise<void> => {
        try {
          await backfillMemoryVectors(memoryStore, memoryConfig, vectorStore);
        } catch (cause) {
          diagnostics.failure('memory.vector_backfill_detached_failed', toKinuError({
            doing: 'backfilling semantic-memory vectors at runtime construction',
            cause,
            otherwise: 'unavailable',
          }), { workspace: actor.workspaceName });
        }
      })(),
      (async (): Promise<void> => {
        try {
          await deviceTransport.refreshStatus();
        } catch (cause) {
          diagnostics.failure('device.status_warmup_failed', toKinuError({
            doing: 'warming the device hub presence at runtime construction',
            cause,
            otherwise: 'unavailable',
          }), { workspace: actor.workspaceName });
        }
      })(),
    ]);
  })();

  // Scoped to the directory named at `kinu connect` unless the device's Sandbox switch is off. A failed
  // hub read is rethrown with its cause, never answered as null. Answers are per machine.
  const deviceScope = async (
    field: 'consentedRoot' | 'deviceHome',
    deviceId: string | undefined,
  ): Promise<string | null> => {
    const hub = userDOStubFor(env, actor);

    if (!hub) return null;

    try {
      const status = await hub.deviceRuntimeStatus(await userCallerFor(actor));

      if (deviceId === undefined) return status[field] ?? null;

      return status.devices?.find((device) => device.id === deviceId)?.[field] ?? null;
    } catch (cause) {
      throw toKinuError({
        doing: "reading the device's consented directory",
        cause,
        otherwise: 'unavailable',
      });
    }
  };

  executionRouter.register(createDeviceTunnelExecutor(deviceTransport, {
    consentedRoot: async (deviceId) => cliCwdForDevice() ?? await deviceScope('consentedRoot', deviceId),
    deviceHome: async (deviceId) => cliCwdForDevice() ?? await deviceScope('deviceHome', deviceId),
    scope: async (deviceId) => {
      const hub = userDOStubFor(env, actor);

      if (!hub) return 'root';

      try {
        return (await hub.getDeviceFileView(await userCallerFor(actor), actor.workspaceName, deviceId)).scope;
      } catch (cause) {
        throw toKinuError({
          doing: "reading the device's file-view scope",
          cause,
          otherwise: 'unavailable',
        });
      }
    },
  }));

  const runtime: CFRuntime = {
    actor: actor.actor,
    storage: { vfs: agentFileVfs, sql, execRaw, transactionSync: write => access.ctx.storage.transactionSync(write) },
    agentStateVfs: originVfs,
    workspaceIsMachine: false,
    startupWork,
    memory, executor, llm, schedule, identity, craftStore,
    get judgeModel() { return profileLane('judge'); },
    get fastLlm() { return profileLane('fast'); },
    get advisorLlm() { return profileLane('advisor'); },
    spawnBranch: (branchId) => requireBranches(hooks).spawn(branchId),
    abortBranch: (branchId) => requireBranches(hooks).abort(branchId),
    executionRouter,
    shell,
    localVfs: baseWorkspaceVfs,
    deviceTransport,
    vectorStore,
    sandboxHandle,
  };

  return runtime;
}

const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';

/** Vectorize-backed only when both env.AI and env.MEMORY_VECTORS are bound; otherwise noop (FTS5-only). */
function buildVectorStore(
  env: Env,
  actor: ActorRuntimeIdentity,
  reportModelCall?: ModelCallSink,
): VectorStore {
  const aiBinding = env.AI;
  const vectorizeBinding = env.MEMORY_VECTORS;

  if (!aiBinding || !vectorizeBinding) {
    return createNoopVectorStore();
  }

  try {
    const embedder = reportModelCall
      ? createWorkersAIEmbedder({ aiBinding, model: EMBEDDING_MODEL, dimensions: 384, reportModelCall })
      : createWorkersAIEmbedder({ aiBinding, model: EMBEDDING_MODEL, dimensions: 384 });

    const store = createCloudflareVectorStore({
      index: vectorizeBinding,
      embedder,
      // Shared index across workspaces: scope every write and query to this one.
      namespace: actor.workspaceName,
    });

    diagnostics.event('vector.store_registered', { namespace: actor.workspaceName });

    return store;
  } catch (err) {
    diagnostics.failure('vector.store_construction_failed', toKinuError({
      doing: 'constructing the Vectorize memory store',
      cause: err,
      otherwise: 'unavailable',
    }), { namespace: actor.workspaceName });

    return createNoopVectorStore();
  }
}

function createExecutor(loader: WorkerLoader): Executor {
  const dwe = new DynamicWorkerExecutor({ loader });

  return {
    languages: ['javascript'],
    async execute(code: string, providers: ResolvedProvider[]): Promise<ExecuteResult> {
      try {
        const normalized = Array.isArray(providers)
          ? providers
          : [{ name: 'codemode', fns: providers }];

        const bridged = normalized.map((provider) => ({
          name: provider.name,
          fns: Object.fromEntries(Object.entries(provider.fns).map(([name, fn]) => [
            name,
            async (...args: unknown[]) => fn(...args.map((value) => decodeJsonValue({ value }))),
          ])),
        }));

        const res = await dwe.execute(code, bridged);
        const result = res.result === undefined ? undefined : decodeJsonValue({ value: res.result });
        const output: ExecuteResult = { result };

        if (res.error !== undefined) output.error = res.error;

        if (res.logs !== undefined) output.logs = res.logs;

        return output;
      } catch (e) {
        return { result: undefined, error: renderThrownChain({ cause: e }) };
      }
    },
  };
}


/** Resolved at call time so a newly connected provider applies without redeploy; not via
 * `OwnedModelServices`, which memoizes under one fixed title. */
function actorProviderRegistry(
  agent: AgentHost,
  env: Env,
  actor: ActorRuntimeIdentity,
  title: string,
): AgentProviderRegistry {
  return createAgentProviderRegistry({
    env,
    userDO: userCredentialSourceFor(env, actor),
    appTitle: title,
    sessionAffinity: agentAffinityKey(agent.name),
  });
}

function reportCall(
  report: ModelCallSink | undefined,
  source: SpendSource,
  spec: string,
  result: { usage?: LanguageModelUsage; response?: { modelId?: string } },
): void {
  if (!report) return;
  const usage = normalizeUsage(result.usage);
  const modelId = result.response?.modelId;
  // `modelId` absent has to mean absent.
  report(modelId !== undefined && modelId.length > 0
    ? { source, spec, usage, modelId }
    : { source, spec, usage });
}

/** `resolveProfile` absent means no lane to build. */
export interface ProfileLaneOptions {
  readonly agent: AgentHost;
  readonly env: Env;
  readonly actor: ActorRuntimeIdentity;
  readonly resolveProfile: (() => Promise<ResolvedTurnProfile>) | undefined;
  readonly source: FixedTierSource;
  readonly report?: ModelCallSink;
}

/** Only a completed call reports: a thrown seam was not billed. */
function createProfileLaneLLM(options: ProfileLaneOptions): LLM | undefined {
  const { agent, env, actor, resolveProfile, source, report } = options;

  if (!resolveProfile) return undefined;

  return createRoutedModelLane(actor.actor, source, {
    resolveProfile,
    llm: route => ({
      async *stream() { yield ""; },
      async complete(prompt: string): Promise<string> {
        const registry = actorProviderRegistry(agent, env, actor, `Kinu (${source})`);

        const providerOptions = reasoningEffortOptions(
          route.reasoningEffort,
          parseModelSpec(route.model).provider,
        );

        const request: Parameters<typeof generateText>[0] = {
          model: registry.resolveModel(route.model),
          prompt,
        };

        if (providerOptions) request.providerOptions = providerOptions;
        const result = await generateText(request);
        reportCall(report, source, route.model, result);

        return result.text.trim();
      },
    }),
  });
}

function createRealSchedule(agent: AgentHost): Schedule {
  return {
    after: async (ms, fn) => { setTimeout(fn, ms); },
    cron: async () => {},
    fiber: async <T>(name: string, fn: (ctx: FiberCtx) => Promise<T>): Promise<T> => {
      return agent.runFiber(name, async (sdkCtx) => {
        const snapshot = sdkCtx.snapshot === null
          ? null
          : decodeJsonValue({ value: sdkCtx.snapshot });

        return fn({ stash: sdkCtx.stash.bind(sdkCtx), snapshot });
      });
    },
  };
}

function createIdentity(
  actor: ActorHandle,
  vfs: CoreVFS,
  sql: SqlExecutor,
  scaffoldPath: string,
): Identity {
  return {
    id: actor.actorId,
    name: actor.name,
    // `.vN` files are canonical; reads resolve pointer-first so a stale live view is healed.
    scaffold: createScaffoldSurface({ vfs, sql, actor, path: scaffoldPath }),
  };
}

function requireBranches(hooks: CFRuntimeHooks): NonNullable<CFRuntimeHooks['branches']> {
  const branches = hooks.branches;

  if (!branches) {
    throw new KinuError('missing', 'This actor runtime was built without a branch host, so it cannot run MCTS rollouts.');
  }

  return branches;
}

