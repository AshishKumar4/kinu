import type { VFS as CoreVFS } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * CF runtime adapter: bridges the Agents DO context to core's AgentRuntime. One Durable Object per
 * workspace; VFS, shell, memory and craft stores all live in the owning actor's `ctx.storage.sql`.
 */

import type { AgentRuntime, ActorHandle, LLM, Schedule, Identity, SqlExecutor, SqlValue, RawSqlExec, FiberCtx, ExecutionRouter, TurnAccumulator, DeferredApprovalChannel, WriteObserver, ModelCallSink, ModelOperationSink, ResolvedTurnProfile, SlateCallResult, SlateOperation, ChildContextResolver, ContextTree } from "@kinu.run/core";
import {
  nimbusSessionFiles, nimbusSessionShell, createShellSession,
  observeWrites,

  DefaultExecutionRouter, createNimbusWorkspaceExecutor,
  withMountTable, standardMounts, contextMount, skillsMount,
  sharedDriveMount, SHARED_DRIVE_UNCLAIMED, SHARED_DRIVE_UNBOUND, type MossaicVfs,
  withApprovalGatedShell, withApprovalGatedFiles, createInheritedApprovalPolicy, holdsGrant,
  type ShellApprovalPolicy, type ShellApprovalMode, type ApprovalGrant,
  type EgressSecretBinding,
  createSandboxExecutor, createDeviceTunnelExecutor, type DeviceTransport,
  type NimbusSandboxHandle,
  createCloudflareVectorStore, createWorkersAIEmbedder, createNoopVectorStore,
  decodeJsonValue,
  createRoutedModelLane, routedLlm, bindRoute,
  createScaffoldSurface,
  type FixedTierSource,
  type VectorStore,
} from "@kinu.run/core";
import type { DeviceFileScope, LiveRead, SandboxHandle } from "@kinu.run/core";
import { JOB_STAMP_ENV, withHostedNodeExecution, WORKSPACE_ROOT, type PortHolders, cloudPlanes } from '@kinu.run/core';
import type { ActorReference, HostedNodeHome, TierRefusals } from '@kinu.run/core';
import { mountActorFiles } from './workspace-host';

export { withHostedNodeExecution, type HostedNodeHome } from '@kinu.run/core';

import { diagnostics, toKinuError } from "@kinu.run/core/obs";
import { kinuEgressParams } from "./egress/configure";
import { BOX_SIZES, BOX_SIZE_ORDER, DEFAULT_BOX_SIZE, type BoxSize } from "@kinu.run/devbox/sizes";
import { accountSandboxSize, SANDBOX_SIZE_CONFIG_KEY } from "./sandbox-size";
import { driveBound, tenantDrive } from "./drive/tenant";
import { adaptCloudflareSandbox } from "./sandbox-exec-lane"
import { previewHostSuffix } from "@kinu.run/core";
import { createDecisionPort } from "@kinu.run/core";
import { sandboxIdForWorkspace } from "@kinu.run/core";
import { sandboxPreviewExposures } from "@kinu.run/core";
import { MemoryStore } from "@kinu.run/agent-utils/memory";
import { CraftStore as AgentUtilsCraftStore } from "@kinu.run/agent-utils/stores";
import { codemodeLauncher, createRuntimeExecutor } from "./codemode-sandbox";
import type { Agent } from "agents";
import {
  createHubDeviceTransport,
  type DeviceHubClient,
  type HubDeviceTransportOpts,
} from "@kinu.run/core";
import {
  createAgentProviderRegistry,
  decisionRunOf,
  type AgentProviderRegistry,
  type UserCredentialClient,
  type UserCredentialSource,
} from "./providers/agent-registry";
import { ownerCaller, type UserCaller } from "@kinu.run/core";
import { adaptMemory, backfillMemoryVectors } from "@kinu.run/core";
import { agentAffinityKey } from "@kinu.run/core";
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

const boundSql = new WeakMap<AgentSqlSource, SqlExecutor>();

/** The workspace's stores share one executor identity, including hosted actors' runtimes. */
export function bindAgentSql(agent: AgentSqlSource): SqlExecutor {
  let sql = boundSql.get(agent);

  if (sql === undefined) {
    sql = agent.sql.bind(agent);
    boundSql.set(agent, sql);
  }

  return sql;
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
  getConfig(caller: UserCaller, key: string): Promise<string | null>;
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

async function ownerSandboxSize(env: Env, actor: ActorRuntimeIdentity): Promise<BoxSize | null> {
  const owner = userDOStubFor(env, actor);

  return owner === null ? null : accountSandboxSize(await owner.getConfig(await ownerCaller(env), SANDBOX_SIZE_CONFIG_KEY));
}

const SANDBOX_SIZES = {
  sizes: BOX_SIZE_ORDER.map((size) => ({ size, ...BOX_SIZES[size] })),
  defaultSize: DEFAULT_BOX_SIZE,
};

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
  localVfs: ReturnType<typeof nimbusSessionFiles>;
  /** `refreshStatus()` is awaited at turn start. */
  deviceTransport: DeviceTransport;
  vectorStore: import("@kinu.run/core").VectorStore;
  startupWork: Promise<void>;
  sandboxHandle: SandboxHandle | null;
  /** Who holds the box's exposed ports, read without the executor's touch; null until this activation used its box:
   *  a call activates the box's object, and only real use keeps a box alive (D56). */
  sandboxPortHolders(): PortHolders | null;
};

/** Every runtime this backend builds carries a vector store (noop when unbound). */
export function isCFRuntime(runtime: AgentRuntime): runtime is CFRuntime {
  return 'vectorStore' in runtime;
}

export interface WorkspaceBoxUse {
  used: boolean;
}

export interface CFRuntimeHooks {
  /** Read at exec time, as resolving during construction re-enters the runtime getter. Undefined (head,
     *  subordinate): no queue, so 'strict' refuses. */
  deferrals?: () => DeferredApprovalChannel | undefined;
  slate?: (operation: SlateOperation) => Promise<SlateCallResult>;
  workspaceObserver?: WriteObserver;
  liveReadsMoved?: (reads: readonly LiveRead[]) => void;
  /** A sandbox port was exposed or withdrawn, which can change the job that serves it; awaited by the call. */
  servingMoved: () => Promise<void>;
  readonly boxUse: WorkspaceBoxUse;
  /** Where non-turn model seams (judge, fast tier, reflection, embedder) report cost; turn spend arrives
     *  as `step_finish`. */
  reportModelCall: ModelCallSink;
  modelOperations: ModelOperationSink;
  resolveProfile?: () => Promise<ResolvedTurnProfile>;
  currentTurn?: (actor: ActorReference) => string | null;
  /** The actor's one notice state for its object's life; the root's titling and settings changes use it too. */
  refusals: TierRefusals;
  /** The actor's uid on both planes, or neither: split credentials measured `EACCES` on its own home
     *  and could write a sibling's. */
  workspaceExecution?: HostedNodeHome;
  /** `children` is opened under the actor host's directory authority, never by a caller knowing an id. */
  contextPlane?: {
    readonly actorId: string;
    own(): ContextTree;
    readonly children: ChildContextResolver;
  };
}

export function createCFRuntime(
  agent: AgentHost,
  access: CFRuntimeAccess,
  actor: ActorRuntimeIdentity,
  hooks: CFRuntimeHooks,
): CFRuntime {
  const sql = bindAgentSql(agent);
  const execRaw: RawSqlExec = (ddl: string) => access.ctx.storage.sql.exec(ddl);

  const env = access.env;
  const workspaceBox = access.workspaceBox(actor.shellId);

  const executionBox = hooks.workspaceExecution
    ? withHostedNodeExecution(workspaceBox, hooks.workspaceExecution)
    : workspaceBox;

  // Workspace state belongs to the session user: a facet's uid could not create entries under `.kinu`.
  const originVfs = nimbusSessionFiles(workspaceBox, { home: WORKSPACE_ROOT });

  // Both of the actor's planes or neither (see `workspaceExecution`). This unmounted tree keeps foreign
  // bytes out of memory and agent-state snapshots.
  const baseWorkspaceVfs = hooks.workspaceExecution
    ? nimbusSessionFiles(workspaceBox, hooks.workspaceExecution)
    : originVfs;

  const observedWorkspaceVfs = hooks.workspaceObserver
    ? observeWrites(baseWorkspaceVfs, hooks.workspaceObserver)
    : baseWorkspaceVfs;

  const memoryStore = new MemoryStore(originVfs, sql);
  memoryStore.ensureSchema();

  // Built before the memory adapter so writes embed.
  const vectorStore = buildVectorStore(env, actor, hooks.reportModelCall);
  const memoryConfig = actor.actor.config;

  const craftStore = new AgentUtilsCraftStore(sql);
  craftStore.ensureSchema();

  const memory = adaptMemory(memoryStore, originVfs, { store: vectorStore, config: memoryConfig });

  const executor = createRuntimeExecutor(codemodeLauncher({ kinuNode: false, egress: null }));

  const profileLane = (source: FixedTierSource): LLM | undefined => createProfileLaneLLM({
    agent, env, actor, resolveProfile: hooks.resolveProfile, source, report: hooks.reportModelCall, currentTurn: hooks.currentTurn,
    refusals: hooks.refusals,
    modelOperations: hooks.modelOperations,
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

  // The agent's own workspace, whose shell also serves the user's device and Drive; codemode runs in it too.
  const home = hooks.workspaceExecution?.home ?? WORKSPACE_ROOT;
  const sessionShell = nimbusSessionShell(executionBox, { home });

  const shellSession = createShellSession({
    home,
    userRoots: () => agentFileVfs.userRoots(),
    stored: async (name) => await sessionShell.cwd?.(name) ?? null,
  });

  const planes = cloudPlanes(home);
  const shell = withApprovalGatedShell(sessionShell, { filesOwner: 'agent', shellSession, planes }, approvalPolicy);

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
      actorId: plane.actorId,
      // A thunk: a mount must not capture a store bound to a since-retired identity.
      own: () => plane.own(),
      children: plane.children,
    }));
  }

  const agentFileVfs = withMountTable(observedWorkspaceVfs, mounts);
  const unmount = mountActorFiles(workspaceBox, agentFileVfs, { rootActor: actor.rootActor, cred: hooks.workspaceExecution?.cred });

  const toolFiles = withApprovalGatedFiles(agentFileVfs, 'workspace', {
    planes, userRoots: () => agentFileVfs.userRoots(), locate: null, parksWrites: true,
  }, approvalPolicy);

  executionRouter.register(createNimbusWorkspaceExecutor({
    box: executionBox,
    shellSession,
    // Declared exactly when NIMBUS_RUNTIME_CACHE is bound: without it there is nothing to install.
    runtimeCatalog: env.NIMBUS_RUNTIME_CACHE !== undefined,
    inboundNetwork: nimbusPreviewConfigured(env),
    inline: {
      vfs: toolFiles, files: agentFileVfs, memory, craftStore, shell, planes,
      sql,
      ledger: () => access.acc?.().files,
      budget: () => access.acc?.().context,
      slate: hooks.slate,
    },
  }));
  const previewSuffix = previewHostSuffix(env) ?? undefined;
  const sandboxId = sandboxIdForWorkspace(actor.workspaceName);
  const machineShells = { scope: actor.shellId, stateDirectory: '~/.kinu/shells' };
  let sandboxHandle: SandboxHandle | null = null;

  if (env.KinuDevbox) {
    try {
      const sdk = env.KinuDevbox.getByName(sandboxId);

      // Egress is configured before the container runs anything, not in `onStart` (too late); until then
      // the container has no network, so it fails closed. Only the owning workspace configures.
      const handle = adaptCloudflareSandbox(sdk, async () => {
        hooks.boxUse.used = true;
        const userId = actor.ownerUserId();

        if (!userId) return;
        await sdk.configureEgress(kinuEgressParams({
          workspaceName: actor.workspaceName,
          ownerUserId: userId,
          vault: await listOwnerEgressVault(env, actor),
          grants: memoryConfig.getShellApprovalGrants(),
        }));
        // Unread, the box keeps its last default.
        const [accountSize] = await Promise.allSettled([ownerSandboxSize(env, actor)]);

        if (accountSize.status === 'fulfilled') await sdk.useDefaultSize(accountSize.value);
        else diagnostics.failure('sandbox.account_size_unread', toKinuError({
          doing: "reading the owner's sandbox size", cause: accountSize.reason, otherwise: 'unavailable',
        }), { sandboxId });
      },
      // The edge proves a preview hostname from `AUTH_KV` without creating the per-name DO.
      env.AUTH_KV ? sandboxPreviewExposures(env.AUTH_KV, sandboxId) : null,
      async () => {
        hooks.liveReadsMoved?.(['getExposedPorts']);
        await hooks.servingMoved();
      });

      sandboxHandle = handle;
      executionRouter.register(createSandboxExecutor(handle, {
        previewHostSuffix: previewSuffix,
        activated: () => hooks.liveReadsMoved?.(['getExecutors', 'getToolDescriptions', 'getExposedPorts']),
        sizes: SANDBOX_SIZES,
        shells: machineShells,
      }));
      diagnostics.event('sandbox.executor_registered', {
        sandboxId,
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
    onStatusChanged: () => hooks.liveReadsMoved?.(['getExecutors', 'getToolDescriptions']),
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
  }, approvalPolicy, machineShells));

  const resolveTurnProfile = hooks.resolveProfile;

  const runtime: CFRuntime = {
    actor: actor.actor,
    storage: { vfs: agentFileVfs, home: hooks.workspaceExecution?.home ?? WORKSPACE_ROOT, sql, execRaw, transactionSync: write => access.ctx.storage.transactionSync(write) },
    agentStateVfs: originVfs,
    toolFiles,
    planes,
    startupWork,
    memory, executor, llm, schedule, identity, craftStore,
    get judgeModel() { return profileLane('judge'); },
    get fastLlm() { return profileLane('fast'); },
    ...(resolveTurnProfile !== undefined && {
      decide: createDecisionPort({
        run: decisionRunOf({ env, userDO: userCredentialSourceFor(env, actor) }),
        model: async () => (await resolveTurnProfile()).decisionModel,
        report: hooks.reportModelCall,
        refusals: hooks.refusals,
      }),
    }),
    executionRouter,
    shell,
    nodeIsolated: true,
    localVfs: baseWorkspaceVfs,
    deviceTransport,
    vectorStore,
    sandboxHandle,
    sandboxPortHolders: () => {
      const handle = sandboxHandle;

      if (handle === null || !hooks.boxUse.used || previewSuffix === undefined) return null;

      return {
        exposedPorts: async () => (await handle.getExposedPorts(previewSuffix)).map((row) => row.port),
        holders: (ports) => handle.portListeners(JOB_STAMP_ENV, ports),
      };
    },
  };

  if (unmount !== undefined) runtime.release = unmount;

  return runtime;
}

const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';

/** Vectorize-backed only when both env.AI and env.MEMORY_VECTORS are bound; otherwise noop (FTS5-only). */
function buildVectorStore(
  env: Env,
  actor: ActorRuntimeIdentity,
  reportModelCall: ModelCallSink,
): VectorStore {
  const embedder = createWorkersAIEmbedder({ env, model: EMBEDDING_MODEL, dimensions: 384, report: reportModelCall });
  const vectorizeBinding = env.MEMORY_VECTORS;

  if (!embedder || !vectorizeBinding) {
    return createNoopVectorStore();
  }

  try {
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



/** Resolved at call time so a newly connected provider applies without redeploy; not via
 * `OwnedModelServices`, which memoizes under one fixed title. */
function actorProviderRegistry(lane: Pick<ProfileLaneOptions, 'env' | 'actor' | 'currentTurn'>, title: string): AgentProviderRegistry {
  const { env, actor, currentTurn } = lane;

  return createAgentProviderRegistry({
    ...(currentTurn !== undefined && { currentTurn }),
    env,
    ownerUserId: actor.ownerUserId(),
    userDO: userCredentialSourceFor(env, actor),
    appTitle: title,
  });
}

/** Where the owner changes a tier's model, as a refusal notice names it. */
export const MODEL_SETTINGS = 'Settings > Models';

/** `resolveProfile` absent means no lane to build. */
export interface ProfileLaneOptions {
  readonly agent: AgentHost;
  readonly env: Env;
  readonly actor: ActorRuntimeIdentity;
  readonly resolveProfile: (() => Promise<ResolvedTurnProfile>) | undefined;
  readonly source: FixedTierSource;
  readonly report: ModelCallSink;
  readonly modelOperations: ModelOperationSink;
  readonly currentTurn: ((reference: ActorReference) => string | null) | undefined;
  readonly refusals: TierRefusals;
}

/** Only a completed call reports: a thrown seam was not billed. */
function createProfileLaneLLM(options: ProfileLaneOptions): LLM | undefined {
  const { actor, resolveProfile, source, report, refusals } = options;

  if (!resolveProfile) return undefined;

  return createRoutedModelLane(actor.actor, source, {
    resolveProfile,
    refusals,
    credentialOf: (spec) => {
      const agent = actorProviderRegistry(options, `Kinu (${source})`);

      return agent.registry.credentialFor(agent.normalizeSpecSync(spec), agent.deps);
    },
    llm: (route) => routedLlm((serving) => {
      const registry = actorProviderRegistry(options, `Kinu (${source})`);

      return bindRoute({
        normalize: (spec) => registry.normalizeSpecSync(spec),
        resolve: (spec) => registry.resolveModel(spec, agentAffinityKey(options.agent.name)),
      }, serving);
    }, route, { report, operations: options.modelOperations }),
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

