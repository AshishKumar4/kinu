/**
 * CF runtime adapter — bridges Think's DO context to core's AgentRuntime.
 *
 * Workspace storage is one NIMBUS_SESSION Durable Object:
 *   VFS      → Nimbus SDK files in the session.
 *   Shell    → Nimbus SDK exec over those same bytes.
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
  WriteObserver,
} from "@proteus/core";
import {
  nimbusSessionFiles, nimbusSessionShell,
  observeWrites,
  type WorkspaceVFS,
  DefaultExecutionRouter, createNimbusWorkspaceExecutor,
  withApprovalGatedShell, createInheritedApprovalPolicy,
  type ShellApprovalPolicy, type ShellApprovalMode, type ApprovalGrant,
  type EgressSecretBinding,
  createSandboxExecutor, createDeviceTunnelExecutor, type DeviceTransport,
  type NimbusSandboxHandle,
  createCloudflareVectorStore, createWorkersAIEmbedder, createNoopVectorStore,
  decodeJsonValue,
  effortFor,
  createAgentConfigStore, initAgentConfigTable, selectFastModel,
  type VectorStore,
} from "@proteus/core";
import type { SandboxHandle } from "@proteus/core";
import { getSandbox } from "@cloudflare/sandbox";
import { configureContainerEgress, withConfiguredEgress } from "./egress/configure.js";
import { previewHostSuffix } from "./lib/preview-origin.js";
import { MemoryStore } from "@proteus/agent-utils/memory";
import { CraftStore as AgentUtilsCraftStore } from "@proteus/agent-utils/stores";
import { generateText } from "ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { Agent } from "agents";
import { abortExplorationFacet, deleteExplorationFacet, spawnBranchFacet } from "./facet-spawn.js";
import {
  createHubDeviceTransport,
  type DeviceHubClient,
  type HubDeviceTransportOpts,
} from "./device-transport.js";
import {
  createAgentProviderRegistry,
  type UserCredentialClient,
  type UserCredentialSource,
} from "./providers/agent-registry.js";
import { resolveJudgeModelSelection } from "./providers/judge-model.js";
import { ownerCaller, type UserCaller } from "./user/workspace-capability.js";
import { adaptMemory, backfillMemoryVectors } from "./memory-sync.js";
import { agentAffinityKey, explorePrompt, formatInheritedContext, normalizeUsage, reflectionPrompt } from "@proteus/core";
import type { ProteusSandbox } from "./proteus-sandbox.js";
import {
  createNimbusWorkspaceSandbox,
  nimbusPreviewConfigured,
  nimbusPreviewUrl,
} from "./nimbus-route.js";
import * as v from 'valibot';

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
type AgentHost = Pick<Agent<Env>, 'name' | 'sql' | 'runFiber' | 'subAgent' | 'abortSubAgent' | 'deleteSubAgent'>;

export interface CFRuntimeAccess {
  readonly env: Env;
  readonly ctx: DurableObjectState;
  /** The turn's ledger + budget, when this actor has one — ActorAgent
   *  (orchestrator, subordinate) does; ExplorationAgent (a head/fork) does
   *  not, so the `workspace` provider's editFile/readFile/writeFile fall
   *  back to a private ledger there. Optional, not narrowed further than
   *  TurnAccumulator's own two turn-scoped fields, so this stays the same
   *  "bare surface" the type's own docstring commits to. */
  readonly acc?: () => Pick<TurnAccumulator, 'files' | 'context'>;
  getCliCwdForDevice?(): string | null;
  getCheckpointMetaForDevice?(): { turnId: string; sessionId: string } | null;
}

/**
 * The one bridge between the Agents SDK's `Agent.sql` and the SqlExecutor
 * primitive. The SDK types its bound values as scalars only, so it does not
 * nominally satisfy a primitive that admits ArrayBuffer — an assertion is
 * unavoidable, and this is the single place it is made.
 */
export function bindAgentSql(agent: Pick<Agent<Env>, 'sql'>): SqlExecutor {
  // SAFETY: this is the repository's sole Agents-SDK SQL adapter. The SDK and
  // SqlExecutor are the same tagged-template protocol; SqlExecutor additionally
  // admits ArrayBuffer, which Durable Object SQLite accepts at runtime.
  return agent.sql.bind(agent) as SqlExecutor;
}

function errorMessage<Thrown>(thrown: Thrown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/**
 * The actor's identity bootstrap + exec-plane keying — the two things that
 * differ between a top-level workspace DO and a facet actor riding it.
 *
 * The orchestrator passes its own owner lookup (workspace_identity) and its
 * DO name; a facet actor passes its own owner row and the PARENT workspace
 * name, so it shares the authoritative workspace, sandbox container, and
 * device consent instead of materializing fresh planes keyed by facet name.
 * A fork's window onto its parent is not configured here: it is an EXECUTOR
 * the facet registers post-construction (`createParentExecutor`), the same way
 * the sandbox and the device are.
 */
export interface ActorRuntimeIdentity {
  /** Owner userId, or null while unclaimed. Resolved per call — never cached
   *  here, so a first use before owner claim can't bake in null. */
  ownerUserId(): string | null;
  /** The workspace whose exec planes (workspace, sandbox, /pc consent) this
   *  actor rides. */
  workspaceName: string;
  /** Stable shell state within the shared workspace session. Distinct actors
   * share files, processes and ports without sharing cwd or exported env. */
  shellId: string;
  /** Live scaffold file for this actor. The default agent owns the canonical
   * workspace scaffold; facets keep their independently versioned control
   * program under the same workspace's internal actor directory. */
  scaffoldPath: string;
  /** The workspace capability token this actor presents to the UserDO — its
   *  own for a workspace DO, its parent's for a facet. Null until claimed. */
  capabilityToken(): Promise<string | null>;
}

interface RuntimeUserDOClient extends UserCredentialClient, DeviceHubClient {
  getDeviceFsConsent(caller: UserCaller, agentName: string): Promise<{ fullFilesystem: boolean }>;
}

interface RuntimeUserDONamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): RuntimeUserDOClient;
}

function userDOStubFor(env: Env, actor: ActorRuntimeIdentity): RuntimeUserDOClient | null {
  const userId = actor.ownerUserId();
  if (!userId) return null;
  const namespaceView: Partial<RuntimeUserDONamespace> = {};
  Object.assign(namespaceView, {
    idFromName: (name: string) => env.UserDO.idFromName(name),
    get: (id: DurableObjectId) => env.UserDO.get(id),
  });
  // SAFETY: the generated Env.UserDO binding contract exposes these exact
  // UserDO RPC methods; the narrower view avoids instantiating every unrelated
  // RPC signature at each runtime call site.
  const namespace = namespaceView as RuntimeUserDONamespace;
  return namespace.get(namespace.idFromName(userId));
}

/** The owner's whole egress vault, secret-free. Empty when the workspace is
 *  unclaimed or the UserDO cannot be reached: an unreadable vault must narrow
 *  what the container may spend, never widen it. */
async function listOwnerEgressVault(
  env: Env, actor: ActorRuntimeIdentity,
): Promise<EgressSecretBinding[]> {
  try {
    const vaultView: Partial<EgressVaultClient> = {};
    const userId = actor.ownerUserId();
    if (!userId) return [];
    Object.assign(vaultView, env.UserDO.get(env.UserDO.idFromName(userId)));
    // SAFETY: the compiler guarantees this name is a real UserDO method — it is
    // declared public there and listed in USER_DO_METHODS, whose
    // `as const satisfies readonly (keyof UserDO)[]` contract fails the build on
    // a typo, so `sealRpcSurface` leaves it reachable on the stub.
    // unit-egress-vault.test.ts asserts it is on USER_DO_RPC_SURFACE.
    const vault = vaultView as EgressVaultClient;
    return [...await vault.listEgressSecrets(await ownerCaller(env))];
  } catch (err) {
    console.warn("[proteus] egress vault unreadable, no secret is injectable:", errorMessage(err));
    return [];
  }
}

interface EgressVaultClient {
  listEgressSecrets(caller: UserCaller): Promise<readonly EgressSecretBinding[]>;
}

/** This actor's identity for a privileged UserDO call. Rejects — rather than
 *  degrading to some weaker principal — when the workspace has no token. */
async function userCallerFor(actor: ActorRuntimeIdentity): Promise<UserCaller> {
  const workspaceToken = await actor.capabilityToken();
  if (!workspaceToken) throw new Error('This workspace has not been issued a capability token yet.');
  return { workspaceToken };
}

/** The root workspace DO's standing approval answers, for a facet riding it.
 *
 *  Both methods are already on `ORCHESTRATOR_RPC_SURFACE` (they arrive through
 *  `AGENT_RPC_ACCESS`), so this needs no new RPC. They are fetched together so
 *  one decision costs one round trip rather than two. */
async function fetchRootApprovalPolicy(
  env: Env, workspaceName: string,
): Promise<{ mode: ShellApprovalMode; grants: readonly ApprovalGrant[] }> {
  const rootView: Partial<RootApprovalClient> = {};
  Object.assign(rootView, env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(workspaceName)));
  // SAFETY: checked by construction and pinned by a test. Both names are keys of
  // AGENT_RPC_ACCESS (cli/rpc-gate.ts), and ORCHESTRATOR_RPC_SURFACE is built by
  // spreading `Object.keys(AGENT_RPC_ACCESS)`, so their reachability is a
  // consequence of that spread rather than a second list that could drift.
  // unit-facet-grant-inheritance.test.ts asserts both are on the surface.
  const root = rootView as RootApprovalClient;
  const [mode, grants] = await Promise.all([
    root.getShellApprovalMode(), root.getShellApprovalGrants(),
  ]);
  return { mode: mode.mode, grants: grants.grants };
}

interface RootApprovalClient {
  getShellApprovalMode(): Promise<{ mode: ShellApprovalMode }>;
  getShellApprovalGrants(): Promise<{ grants: readonly ApprovalGrant[] }>;
}

/** The credential source for a provider registry built inside an actor. Null
 *  when the workspace is unclaimed, leaving only env-bound providers usable —
 *  the pre-existing behaviour for an ownerless agent. */
function userCredentialSourceFor(env: Env, actor: ActorRuntimeIdentity): UserCredentialSource | null {
  const stub = userDOStubFor(env, actor);
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
  /** Attribute writes made through this actor's canonical workspace file
   * plane. Used by heads to report only their own direct file mutations while
   * every actor still addresses the same workspace. */
  workspaceObserver?: WriteObserver;
}

/**
 * Build a full AgentRuntime from a Think agent's DO context.
 */
export function createCFRuntime(
  agent: AgentHost,
  access: CFRuntimeAccess,
  actor: ActorRuntimeIdentity,
  hooks: CFRuntimeHooks = {},
): CFRuntime {
  const sql = bindAgentSql(agent);
  const execRaw: RawSqlExec = (ddl: string) => access.ctx.storage.sql.exec(ddl);

  const env = access.env;
  if (!env.NIMBUS_SESSION) {
    throw new Error('CF runtime requires the NIMBUS_SESSION binding: the Nimbus session is the hosted workspace');
  }
  const workspaceBox = createAgentNimbusHandle(env, actor);
  const workspaceVfs = nimbusSessionFiles(workspaceBox);
  const vfs = hooks.workspaceObserver
    ? observeWrites(workspaceVfs, hooks.workspaceObserver)
    : workspaceVfs;

  // MemoryStore from agent-utils — FTS5-indexed search over the workspace
  // filesystem itself, so `memory/MEMORY.md` is the same file the agent reads
  // with the `file` tool and greps in the shell.
  const memoryStore = new MemoryStore(workspaceVfs, sql);
  memoryStore.ensureSchema();

  // Vectorize-backed semantic memory, scoped to this workspace's namespace.
  // Noop when env.AI / env.MEMORY_VECTORS aren't configured, so hybrid search
  // degrades to FTS5-only. Built before the memory adapter so writes embed.
  const vectorStore = buildVectorStore(env, actor);
  // Owns the semantic-index completeness markers, read by the backfill and
  // cleared by the write path when a sync fails.
  // This factory ensures the schema of every store it opens — the memory and
  // craft stores above do — and it reads config during construction, not only
  // on demand. An exploration facet builds its whole head runtime on its OWN
  // storage, which no `initWorkspaceSchema` touches, so without this every head
  // dies on `no such table: agent_config` before its first step. These are that
  // facet's own settings, as a subordinate facet's are its own; a head's MODEL
  // is not read here — it arrives with the HeadInput the spawner built.
  initAgentConfigTable(execRaw);
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

  const envForExec = env;
  if (!envForExec.LOADER) {
    throw new Error("CF runtime requires env.LOADER binding (worker_loaders in wrangler.jsonc)");
  }
  const executor = createExecutor(envForExec.LOADER);
  const llm = createDualPathLLM(agent, env, actor, sql);
  const schedule = createRealSchedule(agent);
  const identity = createIdentity(agent, access.ctx, vfs, sql, actor.scaffoldPath);

  // Execution router — manages workspace plus the separate sandbox and laptop.
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
  //
  // ROOT vs FACET. `agent.name === actor.workspaceName` is the same test the
  // sandbox handle uses below to decide who owns the container. A facet — a
  // head, a subordinate — is a different Durable Object with its own empty
  // `agent_config`, and grants are only ever written to the ROOT's, so a facet
  // reading its own store found no grants and no mode and re-asked for consent
  // the owner had already given on the workspace. Every agent in a workspace
  // shares one container, so it must share that container's granted
  // capabilities — or a subset, never a superset. `createInheritedApprovalPolicy`
  // is that rule: the root's answers, intersected with any narrowing the facet
  // recorded for itself, and no `remember`, so a facet can never widen.
  const isRootActor = agent.name === actor.workspaceName;
  const approvalPolicy: ShellApprovalPolicy = isRootActor
    ? {
      mode: () => memoryConfig.getShellApprovalMode(),
      // Standing grants, same live read as the mode: an 'always' the owner gave
      // in the needs-you queue takes effect on the very next command.
      granted: (grant) => memoryConfig.getShellApprovalGrants()
        .some((g) => g.rule === grant.rule && g.executor === grant.executor),
      get deferrals() { return hooks.deferrals?.(); },
    }
    : createInheritedApprovalPolicy({
      fetchRoot: () => fetchRootApprovalPolicy(env, actor.workspaceName),
      // `[]` is the normal case and means "this facet has narrowed nothing",
      // so it inherits the root's set whole.
      ownGrants: () => memoryConfig.getShellApprovalGrants(),
    });
  // The workspace shell is the authoritative Nimbus session's shell, over the
  // exact same bytes `vfs` addresses.
  // Gated at the Shell object, so what it wraps is transparent to the seam.
  const shell = withApprovalGatedShell(nimbusSessionShell(workspaceBox), approvalPolicy);
  const executionRouter: ExecutionRouter = new DefaultExecutionRouter(approvalPolicy);
  executionRouter.register(createNimbusWorkspaceExecutor({
    box: workspaceBox,
    runtimeCatalog: env.NIMBUS_RUNTIME_CACHE != null,
    inboundNetwork: nimbusPreviewConfigured(env),
    inline: {
      vfs, memory, craftStore, shell,
      // sql is used by workspace.listTools() to look up EMA craft_scores.
      sql,
      // Optional eager notification; PreambleCraftedExecutor live-reads CraftStore.
      onToolRegistered: hooks.onToolRegistered,
      // Shares the native `file` tool's turn ledger/budget with workspace.*
      // (editFile's gate, readFile/writeFile's observe). The thunks are passed
      // unconditionally and read the supplied turn accumulator only when called.
      ledger: () => access.acc?.().files,
      budget: () => access.acc?.().context,
    },
  }));
  // Register Sandbox executor — Proteus's primary remote exec surface.
  // Backed by @cloudflare/sandbox: one Linux container per agent, keyed
  // by the agent's stable name. `PREVIEW_HOST_SUFFIX` is the zone the SDK
  // builds preview URLs on — `<port>-<sandbox>-<token>.<suffix>`, routed back
  // by preview-proxy.ts. `sandboxId` is the stable DO key those URLs carry.
  const previewSuffix = previewHostSuffix(env) ?? undefined;
  const sandboxId = `proteus-${actor.workspaceName}`;
  let sandboxHandle: SandboxHandle | null = null;
  if (env.Sandbox) {
    try {
      // `transport: 'websocket'` multiplexes the whole container control plane
      // over one WebSocket instead of a request per call. It must be passed
      // identically on EVERY getSandbox() for an id — changing it mid-life
      // disconnects the active client and drops in-flight requests — so this
      // option list is the single place it is chosen (see orchestrator.ts's
      // release-preview lookup, which passes the same).
      const sdk = getSandbox(env.Sandbox, sandboxId, { normalizeId: true, transport: "websocket" });
      // Egress interception is configured before the container can run anything,
      // and awaited inside the operation that needed it. Not in `onStart`: the
      // Container base re-applies its persisted outbound configuration
      // immediately BEFORE `container.start()`, and `onStart` runs after the
      // container is already up, so the hook is too late to install it. Until it
      // lands the container has no network at all — `enableInternet = false` with
      // no handler bound means the platform denies everything — so the window
      // before configuration fails closed rather than leaking an unintercepted
      // request. Only the workspace that OWNS the grants configures; a facet
      // rides the configuration its root installed.
      const handle = withConfiguredEgress(adaptCloudflareSandbox(sdk), async () => {
        const userId = actor.ownerUserId();
        if (!userId) return;
        await configureContainerEgress(sdk, {
          workspaceName: actor.workspaceName,
          ownerUserId: userId,
          vault: await listOwnerEgressVault(env, actor),
          grants: memoryConfig.getShellApprovalGrants(),
        });
      });
      sandboxHandle = handle;
      // No restore wrapper here, deliberately. Restoring /workspace is the
      // container's own affair and happens in ProteusSandbox.onStart, inside the
      // blockConcurrencyWhile that no exec can jump ahead of. The predicate this
      // replaced ("only the container's owner may decide a restore") existed to
      // stop a facet reading its own empty `agent_config` and latching the
      // container as restored; with the state on the container's own object
      // there is one reader, one writer, and nothing to arbitrate.
      // The executor carries its own file view over this same handle, for the
      // file manager's sandbox pane. An unset PREVIEW_HOST_SUFFIX turns off
      // previews alone: exec, files and the release engine keep working, and
      // port exposure refuses with the preview-specific reason.
      executionRouter.register(createSandboxExecutor(handle, previewSuffix));
      console.log(`[proteus] SandboxExecutor registered (${previewSuffix ? `previews=*.${previewSuffix}` : "previews off — PREVIEW_HOST_SUFFIX unset"} id=${sandboxId} transport=websocket)`);
    } catch (err) {
      console.warn("[proteus] Failed to register SandboxExecutor:", errorMessage(err));
      executionRouter.register(createSandboxExecutor());
    }
  } else {
    executionRouter.register(createSandboxExecutor());
  }

  // Register the laptop executor. The device socket lives on the user's UserDO
  // (the user-level hub), so this executor FORWARDS each JSON-RPC call there —
  // one connected device serves all of the user's agents.
  const cliCwdForDevice = () => access.getCliCwdForDevice?.() ?? null;
  const deviceTransportOptions: HubDeviceTransportOpts = {
    hub: () => userDOStubFor(env, actor),
    caller: () => userCallerFor(actor),
    agentName: actor.workspaceName,
    cliCwd: cliCwdForDevice,
    checkpointMeta: () => access.getCheckpointMetaForDevice?.() ?? null,
  };
  const deviceTransport = createHubDeviceTransport(deviceTransportOptions);
  void deviceTransport.refreshStatus();
  // The executor's file view scopes paths to the consented subtree (connect dir
  // / home) unless the agent holds the full-filesystem consent tier on the hub.
  // Action consent (ask-once-then-remember) still applies to every RPC beneath.
  executionRouter.register(createDeviceTunnelExecutor(deviceTransport, {
    consentedRoot: cliCwdForDevice,
    hasFullFilesystem: async () => {
      const hub = userDOStubFor(env, actor);
      if (!hub) return false;
      try {
        return (await hub.getDeviceFsConsent(await userCallerFor(actor), actor.workspaceName)).fullFilesystem;
      } catch (error) {
        // Fail CLOSED: unverifiable consent must narrow the executor to the
        // consented subtree, never widen it. Recorded rather than discarded —
        // `false` alone cannot distinguish "no full-filesystem tier" from "the hub
        // could not be reached", and only one of those is a fault.
        console.warn('[proteus] device full-filesystem consent unverifiable, scoping to subtree:',
          error instanceof Error ? error.message : String(error));
        return false;
      }
    },
  }));

  return {
    storage: { vfs, sql, execRaw },
    memory, executor, llm, schedule, identity, craftStore,
    judgeModel: createJudgeLLM(agent, env, actor, sql),
    fastLlm: createFastLLM(agent, env, actor, sql),
    spawnBranch: createFacetSpawner(agent, env, actor),
    abortBranch: createFacetAborter(agent),
    releaseBranch: createFacetReleaser(agent),
    executionRouter,
    shell,
    localVfs: workspaceVfs,
    deviceTransport,
    vectorStore,
    sandboxHandle,
  };
}


function createAgentNimbusHandle(env: Env, actor: ActorRuntimeIdentity): NimbusSandboxHandle {
  let cachedKey = "";
  let cachedBox: ReturnType<typeof createNimbusWorkspaceSandbox> | null = null;

  const current = () => {
    const ownerUserId = actor.ownerUserId();
    if (!ownerUserId) {
      throw new Error('Nimbus workspace is unavailable until the workspace owner claim completes');
    }
    const key = `${ownerUserId}|${actor.workspaceName}`;
    if (!cachedBox || cachedKey !== key) {
      cachedKey = key;
      cachedBox = createNimbusWorkspaceSandbox(env, ownerUserId, actor.workspaceName);
    }
    return cachedBox;
  };

  const previewUrl = (port: number, capability: string | null | undefined): string | undefined => {
    const ownerUserId = actor.ownerUserId();
    if (!ownerUserId || !capability) return undefined;
    return nimbusPreviewUrl(env, ownerUserId, actor.workspaceName, port, capability);
  };
  const jsonResult = async (result: Promise<unknown>) => {
    const value = await result;
    return value === undefined ? undefined : decodeJsonValue({ value });
  };

  return {
    ready: () => current().ready(),
    exec: (command, options) => current().exec(command, { ...options, shellId: actor.shellId }),
    startProcess: (command, options) => current().startProcess(command, { ...options, shellId: actor.shellId }),
    runCode: (code, options) => current().runCode(code, { ...options, shellId: actor.shellId }),
    files: {
      read: (path) => current().files.read(path),
      readBytes: (path) => current().files.readBytes(path),
      write: (path, content) => current().files.write(path, content),
      stat: (path) => current().files.stat(path),
      lstat: (path) => current().files.lstat(path),
      rename: (from, to) => current().files.rename(from, to),
      chmod: (path, mode) => current().files.chmod(path, mode),
      list: (path) => current().files.list(path),
      exists: (path) => current().files.exists(path),
      mkdir: (path) => current().files.mkdir(path),
      delete: (path, options) => current().files.delete(path, options),
    },
    runtimes: {
      ensure: (specs, options) => jsonResult(current().runtimes.ensure(specs, options)),
      install: (spec, options) => jsonResult(current().runtimes.install(spec, options)),
      list: () => jsonResult(current().runtimes.list()),
    },
    processes: {
      list: () => jsonResult(current().processes.list()),
      kill: (pid) => jsonResult(current().processes.kill(pid)),
      logs: (pid, options) => jsonResult(current().processes.logs(pid, options)),
    },
    ports: {
      expose: async (port) => {
        const exposed = await current().ports.expose(port);
        if (!exposed.capability) throw new Error(`No process is listening on workspace port ${port}`);
        const url = previewUrl(port, exposed.capability);
        if (!url) throw new Error('Workspace preview URLs are unavailable because the preview host or user-plane secret is not configured');
        return { ...exposed, url };
      },
      unexpose: (port) => current().ports.unexpose(port),
      list: async () => (await current().ports.list()).map((entry) => ({
        ...entry,
        url: previewUrl(entry.port, entry.capability),
      })),
    },
  };
}

async function jsonResultOrVoid<Result>(result: Promise<Result>) {
  const value = await result;
  return value === undefined ? undefined : decodeJsonValue({ value });
}

/** The SDK's response classes are serializable but intentionally do not carry
 * JsonObject index signatures. Rebuild the small portable SandboxHandle at the
 * boundary and validate opaque mutation responses before core observes them. */
function adaptCloudflareSandbox(handle: ProteusSandbox): SandboxHandle {
  return {
    exec: (command, opts) => handle.exec(command, opts),
    readFile: (path, opts) => handle.readFile(path, opts),
    writeFile: (path, content, opts) => jsonResultOrVoid(handle.writeFile(path, content, opts)),
    listFiles: (path, opts) => handle.listFiles(path, opts),
    deleteFile: (path) => jsonResultOrVoid(handle.deleteFile(path)),
    exposePort: (port, opts) => handle.exposePort(port, opts),
    unexposePort: (port) => jsonResultOrVoid(handle.unexposePort(port)),
    getExposedPorts: (hostname) => handle.getExposedPorts(hostname),
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
function buildVectorStore(env: Env, actor: ActorRuntimeIdentity): VectorStore {
  const aiBinding = env.AI;
  const vectorizeBinding = env.MEMORY_VECTORS;
  if (!aiBinding || !vectorizeBinding) {
    return createNoopVectorStore();
  }
  try {
    const embedder = createWorkersAIEmbedder({
      aiBinding,
      model: '@cf/baai/bge-small-en-v1.5',
      dimensions: 384,
    });
    const store = createCloudflareVectorStore({
      index: vectorizeBinding,
      embedder,
      // Shared index across all of the user's workspaces — scope every write
      // and query to this workspace so memories never leak across agents.
      namespace: actor.workspaceName,
    });
    console.log(`[proteus] VectorStore (Cloudflare Vectorize) registered (namespace=${actor.workspaceName})`);
    return store;
  } catch (err) {
    console.warn('[proteus] VectorStore construction failed; falling back to noop:', errorMessage(err));
    return createNoopVectorStore();
  }
}

function adaptCraftStore(impl: AgentUtilsCraftStore): CoreCraftStore {
  return {
    create(t) {
      impl.create({
        name: t.name, description: t.description,
        params: t.params ?? undefined,
        code: t.code, scope: t.scope ?? "local",
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

function adaptCraftedTool(t: ReturnType<AgentUtilsCraftStore['list']>[number]): CoreCraftedTool {
  return {
    name: t.name,
    description: t.description,
    params: t.params,
    code: t.code,
    scope: t.scope,
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
        return { result: undefined, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

// LLM for evolution reflections. Uses the agent's configured provider via
// the registry — picks up Codex/OpenRouter/etc. automatically when the user
// has switched providers.
function readStoredModelSpec(sql: SqlExecutor): string | null {
  // Single canonical path through the typed config store — no raw SQL.
  return createAgentConfigStore(sql).getModel();
}

function createDualPathLLM(
  agent: AgentHost,
  env: Env,
  actor: ActorRuntimeIdentity,
  sql: SqlExecutor,
): LLM {
  return {
    async *stream() { yield ""; },
    async complete(prompt: string): Promise<string> {
      try {
        const reg = createAgentProviderRegistry({
          env,
          userDO: userCredentialSourceFor(env, actor),
          appTitle: 'Proteus',
          workersAI: { sessionAffinity: agentAffinityKey(agent.name) },
        });
        const model = reg.resolveModel(reg.normalizeSpecSync(readStoredModelSpec(sql)));
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
function createFastLLM(
  agent: AgentHost,
  env: Env,
  actor: ActorRuntimeIdentity,
  sql: SqlExecutor,
): LLM | undefined {
  const config = createAgentConfigStore(sql);
  const registry = createAgentProviderRegistry({
    env,
    userDO: userCredentialSourceFor(env, actor),
    appTitle: 'Proteus (fast)',
    workersAI: { sessionAffinity: agentAffinityKey(agent.name) },
  });
  const selected = () => selectFastModel({
    fastSpec: config.getFastModel(),
    chatSpec: registry.normalizeSpecSync(readStoredModelSpec(sql)),
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
function createJudgeLLM(
  agent: AgentHost,
  env: Env,
  actor: ActorRuntimeIdentity,
  sql: SqlExecutor,
): LLM {
  return {
    async *stream() { yield ""; },
    async complete(prompt: string): Promise<string> {
      const config = createAgentConfigStore(sql);
      const registry = createAgentProviderRegistry({
        env,
        userDO: userCredentialSourceFor(env, actor),
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
        const snapshot = sdkCtx.snapshot === null
          ? null
          : decodeJsonValue({ value: sdkCtx.snapshot });
        return fn({ stash: sdkCtx.stash, snapshot });
      });
    },
  };
}

// ── Identity ─────────────────────────────────────────────────────

function createIdentity(
  agent: AgentHost,
  ctx: DurableObjectState,
  vfs: CoreVFS,
  sql: SqlExecutor,
  scaffoldPath: string,
): Identity {
  return {
    id: ctx.id.toString(),
    name: agent.name,
    scaffold: {
      path: scaffoldPath,
      exists: () => vfs.exists(scaffoldPath),
      read: async () => {
        const content = await vfs.readFile(scaffoldPath, { encoding: "utf8" });
        if (!v.is(v.string(), content)) throw new Error(`Scaffold ${scaffoldPath} did not decode as UTF-8 text`);
        return content;
      },
      write: async (code: string) => {
        const slash = scaffoldPath.lastIndexOf('/');
        if (slash > 0) await vfs.mkdir(scaffoldPath.slice(0, slash), { recursive: true });
        await vfs.writeFile(scaffoldPath, code);
      },
      version: async () =>
        (sql<{ v: number }>`SELECT COALESCE(MAX(version), 0) as v FROM scaffold_versions`)[0]?.v ?? 0,
    },
  };
}

// ── MCTS branches via real Facets (spawn seam: facet-spawn.ts) ───

function createFacetSpawner(agent: AgentHost, env: Env, actor: ActorRuntimeIdentity): (branchId: string) => Promise<BranchHandle> {
  return async (branchId: string): Promise<BranchHandle> => {
    try {
      return await spawnBranchFacet(agent, branchId, {
        ownerUserId: actor.ownerUserId(),
        capabilityToken: await actor.capabilityToken(),
      });
    } catch (err) {
      console.warn(`[proteus] subAgent failed for branch ${branchId}: ${errorMessage(err)}. Using inline fallback.`);
      return createInlineBranch(agent, env);
    }
  };
}

function createFacetAborter(agent: AgentHost): (branchId: string) => Promise<void> {
  return async (branchId: string) => { abortExplorationFacet(agent, branchId); };
}

/**
 * TERMINAL release, and the reason this is a separate factory from the aborter
 * above rather than a rename of it: `deleteSubAgent` WIPES the facet's SQLite,
 * which is charged to the ROOT DO's shared ~10 GB quota whose overflow is an
 * uncatchable reset. Merely aborting a branch leaves that database behind
 * forever, because branch ids are never reused.
 *
 * Safe to wipe only because the MCTS engine calls this in the terminal
 * `finally` of an iteration — strictly after that iteration's reflection has
 * already read the branch's own `traces` table. Anything earlier is data loss,
 * which is why mid-flight cancellation still goes through `createFacetAborter`.
 *
 * A branch that fell back to `createInlineBranch` has no facet at all, so
 * releasing one must be harmless: `ctx.facets.delete` does not raise for an
 * absent facet, and the catch below covers the remaining case anyway.
 *
 * Reported rather than thrown, and this is the one place in the module where
 * that is the LOUDER choice: `mcts/engine.ts` releases through
 * `Promise.allSettled`, which discards rejections, so throwing here would
 * produce silence at exactly the moment a database was stranded. `error`, not
 * `warn` — the quota this leaks into resets the whole workspace on overflow.
 */
function createFacetReleaser(agent: AgentHost): (branchId: string) => Promise<void> {
  return async (branchId: string) => {
    try {
      await deleteExplorationFacet(agent, branchId);
    } catch (err) {
      console.error(`[proteus] branch facet ${branchId} storage was not reclaimed: ${errorMessage(err)}`);
    }
  };
}

/**
 * Inline branch fallback — used when Facets are unavailable.
 *
 * Storage isolation (lean/Proteus/MCTS/StorageIsolation.lean: branch storage
 * disjoint from the orchestrator's) is enforced STRUCTURALLY by capturing only
 * the LLM config, never the agent reference or its storage. The closure has
 * no path to agent.sql or agent.ctx.storage.
 */
function createInlineBranch(agent: AgentHost, env: Env): BranchHandle {
  // Capture only env (not agent.sql / agent.ctx.storage) so the branch
  // closure satisfies StorageIsolation. Stored credentials are not available
  // here — with a null UserDO stub the registry's sync default skips the
  // credential-gated workers-ai and uses the env-bound ai-gateway, which
  // needs no credential reads.
  const reg = createAgentProviderRegistry({
    env,
    userDO: null,
    appTitle: 'Proteus (inline branch)',
    workersAI: { sessionAffinity: agentAffinityKey(agent.name) },
  });
  const spec = reg.normalizeSpecSync(null);
  const getModel = () => reg.resolveModel(spec);

  return {
    explore: async (history, craftedTools, languages, mode, siblings = []) => {
      // The SAME question the facet asks (core explorePrompt), so a fallback
      // branch is comparable with a facet one — they are scored against each
      // other. This path once asked a materially weaker version of it while
      // claiming to match, which is exactly what the shared prompt prevents.
      const { system, user } = explorePrompt({
        mode,
        context: formatInheritedContext(history),
        craftedTools,
        languages,
        siblings,
      });
      const result = await generateText({
        model: getModel(),
        system,
        messages: [{ role: "user" as const, content: user }],
        ...effortFor('mcts_rollout'),
      });
      const text = result.text.trim();
      return { text, usage: normalizeUsage(result.usage) };
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
      return { text: result.text.trim(), usage: normalizeUsage(result.usage) };
    },
  };
}
