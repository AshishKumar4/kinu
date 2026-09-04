/**
 * CF runtime adapter — bridges Think's DO context to core's AgentRuntime.
 *
 * ONE DURABLE OBJECT PER WORKSPACE. Everything a workspace stores is in the
 * owning actor's own `ctx.storage.sql`:
 *   VFS      → Nimbus, held as a library over that SQLite (workspace-host.ts).
 *   Shell    → the same Nimbus workspace's shell over those same bytes.
 *   Memory   → MemoryStore (FTS5-indexed markdown chunks of those same files)
 *   CraftStore → CraftStore (FTS5-indexed tool storage)
 *
 * So the indexed bytes and the index rows commit together, a SQL-only snapshot
 * of the object is the whole workspace, and destroying one is one object's
 * teardown. A facet (subordinate, head, swarm node) shares the workspace over a
 * single RPC into that object — see `CFRuntimeAccess.workspaceBox`.
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
  ModelCallSink, SpendSource, ResolvedTurnProfile,
} from "@kinu.run/core";
import {
  nimbusSessionFiles, nimbusSessionShell,
  observeWrites,
  type WorkspaceVFS,
  DefaultExecutionRouter, createNimbusWorkspaceExecutor,
  withMountTable, standardMounts,
  withApprovalGatedShell, createInheritedApprovalPolicy,
  type ShellApprovalPolicy, type ShellApprovalMode, type ApprovalGrant,
  type EgressSecretBinding,
  createSandboxExecutor, createDeviceTunnelExecutor, type DeviceTransport,
  type NimbusSandboxHandle,
  createCloudflareVectorStore, createWorkersAIEmbedder, createNoopVectorStore,
  decodeJsonValue, effortFor,
  createAgentConfigStore, initAgentConfigTable, initActorTables,
  parseModelSpec, reasoningEffortOptions, resolveModelRoute,
  createScaffoldSurface,
  type FixedTierSource,
  type VectorStore,
} from "@kinu.run/core";
import type { SandboxHandle } from "@kinu.run/core";
import { withHostedNodeExecution } from './node-home';
import type { HostedNodeHome } from './node-home';
export { withHostedNodeExecution, type HostedNodeHome } from './node-home';
import { diagnostics, renderThrownChain, toKinuError } from "@kinu.run/core/obs";
import { getSandbox } from "@cloudflare/sandbox";
import { kinuEgressParams } from "./egress/configure";
import { adaptCloudflareSandbox, SANDBOX_TRANSPORT } from "./sandbox-exec-lane";
import { previewHostSuffix } from "./lib/preview-origin";
import { sandboxIdForWorkspace, sandboxPreviewExposures } from "./lib/preview-exposures";
import { MemoryStore } from "@kinu.run/agent-utils/memory";
import { CraftStore as AgentUtilsCraftStore } from "@kinu.run/agent-utils/stores";
import { generateText, type LanguageModelUsage } from "ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { Agent } from "agents";
import { abortExplorationFacet, deleteExplorationFacet, spawnBranchFacet, type FacetHost } from "./facet-spawn";
import {
  createHubDeviceTransport,
  type DeviceHubClient,
  type HubDeviceTransportOpts,
} from "./device-transport";
import {
  createAgentProviderRegistry,
  type AgentProviderRegistry,
  type UserCredentialClient,
  type UserCredentialSource,
} from "./providers/agent-registry";
import { ownerCaller, type UserCaller } from "./user/workspace-capability";
import { adaptMemory, backfillMemoryVectors } from "./memory-sync";
import { agentAffinityKey, explorePrompt, formatInheritedContext, normalizeUsage, reflectionPrompt } from "@kinu.run/core";
import { nimbusPreviewConfigured } from "./nimbus-route";

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
type AgentHost = Pick<Agent<Env>, 'name' | 'sql' | 'runFiber'> & FacetHost;

export interface CFRuntimeAccess {
  readonly env: Env;
  readonly ctx: DurableObjectState;
  /**
   * The workspace's process/port/runtime/exec plane, for the named durable
   * shell.
   *
   * Supplied by the actor rather than built here, because only the actor knows
   * whether it OWNS the workspace. An orchestrator hands over a box composed
   * over its own `ctx.storage.sql`; a subordinate or exploration facet — its own
   * Durable Object with its own SQLite, sharing the orchestrator's tree — hands
   * over a client onto that orchestrator. Both satisfy `NimbusSandboxHandle`, so
   * nothing downstream of this line can tell them apart.
   */
  workspaceBox(shellId: string): NimbusSandboxHandle;
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
  getDeviceFileView(caller: UserCaller, agentName: string, device?: string): Promise<{ unconfined: boolean }>;
}

interface RuntimeUserDONamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): RuntimeUserDOClient;
}

function userDOStubFor(env: Env, actor: ActorRuntimeIdentity): RuntimeUserDOClient | null {
  const userId = actor.ownerUserId();
  if (!userId) return null;
  // SAFETY: the generated Env.UserDO binding contract exposes these exact
  // UserDO RPC methods; the narrower view keeps each runtime call site on the
  // subset it owns rather than instantiating every unrelated RPC signature.
  // NARROWED, NEVER COPIED — a JSRPC stub's methods live behind a Proxy, so an
  // `Object.assign` of one yields `{}` and every call on it is undefined (see
  // `listOwnerEgressVault`).
  const namespace: RuntimeUserDONamespace = env.UserDO;
  return namespace.get(namespace.idFromName(userId));
}

/** The owner's whole egress vault, secret-free. Empty when the workspace is
 *  unclaimed or the UserDO cannot be reached: an unreadable vault must narrow
 *  what the container may spend, never widen it. */
async function listOwnerEgressVault(
  env: Env, actor: ActorRuntimeIdentity,
): Promise<EgressSecretBinding[]> {
  try {
    const userId = actor.ownerUserId();
    if (!userId) return [];
    // The stub is USED, never COPIED. `Object.assign` transfers own enumerable
    // properties, and a JSRPC stub's methods live behind a Proxy rather than on
    // the object, so copying one yields `{}` and every call on it is undefined.
    // Measured on production as `vaultView.listEgressSecrets is not a function`,
    // which this `catch` then swallowed into an empty vault — so the container
    // silently lost every injectable secret. The narrow interface still limits
    // what this call site may reach; it is the copy that was wrong, not the type.
    const vault: EgressVaultClient = env.UserDO.get(env.UserDO.idFromName(userId));
    return [...await vault.listEgressSecrets(await ownerCaller(env))];
  } catch (err) {
    diagnostics.failure('egress.vault_unreadable', toKinuError({
      doing: "reading the owner's egress vault",
      cause: err,
      otherwise: 'unavailable',
    }), { workspace: actor.workspaceName });
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
  // Used, not copied — see `listOwnerEgressVault`. Both names are keys of
  // AGENT_RPC_ACCESS (cli/rpc-gate.ts) and ORCHESTRATOR_RPC_SURFACE is built by
  // spreading `Object.keys(AGENT_RPC_ACCESS)`, so their reachability is a
  // consequence of that spread rather than a second list that could drift.
  // unit-facet-grant-inheritance.test.ts asserts both are on the surface.
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
  vectorStore: import("@kinu.run/core").VectorStore;
  /** Startup maintenance retained by this runtime so construction stays
   *  synchronous without dropping either background operation. */
  startupWork: Promise<void>;
  /** The live sandbox container handle (for /workspace backup/restore), or null
   *  when no Sandbox binding / preview host. Single source for the orchestrator. */
  sandboxHandle: SandboxHandle | null;
};

/** Optional hooks the orchestrator can inject into the CF runtime. */
export interface CFRuntimeHooks {
  /**
   * Fires synchronously from workspace.createTool after a successful
   * create/update. The execute_tools sandbox does not need it because it reads
   * craftStore.list() on every call; other adapters can use it for eager
   * notification.
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
  /**
   * Where the non-turn model seams report what they cost.
   *
   * The turn loop's spend reaches the durable log as `step_finish`. Everything
   * this factory builds a model for — the judge, the fast tier, the evolution
   * engine's reflection, the memory embedder — is invisible to that row, and
   * before this hook existed every one of them discarded the provider's usage
   * report on the line that received it. A workspace total that omitted them
   * silently was the thing the owner could not trust.
   *
   * Optional, and it stays optional: a facet that reports nowhere is a facet
   * whose spend is unattributed, which the coverage fraction states rather than
   * hides.
   */
  reportModelCall?: ModelCallSink;
  /** Immutable profile resolved for the active turn. */
  turnProfile?: () => ResolvedTurnProfile | null;
  /** Resolve a profile for durable work that starts without a chat turn. */
  resolveProfile?: () => Promise<ResolvedTurnProfile>;
  /**
   * A node facet's own identity: the ONE shared Nimbus session, addressed as
   * this node on both planes.
   *
   * Present, commands run as the node's uid from its home and its file plane
   * acts as the same uid; absent, this runtime is the ORIGIN's. Never a second
   * filesystem either way — the session, the bytes and the mount table are the
   * same, and only the credential differs.
   */
  workspaceExecution?: HostedNodeHome;
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
  // The workspace comes from the actor, because WHERE it lives is the actor's
  // own fact: an orchestrator composes Nimbus over its own `ctx.storage.sql`,
  // and a facet holds a client onto the orchestrator that did. This factory
  // reads neither — one box, one interface, either way.
  const workspaceBox = access.workspaceBox(actor.shellId);
  const executionBox = hooks.workspaceExecution
    ? withHostedNodeExecution(workspaceBox, hooks.workspaceExecution)
    : workspaceBox;
  // BOTH PLANES OR NEITHER. A node home is uid/gid/mode on real inodes, so a
  // runtime whose commands were the node's while its file tools stayed the
  // session user could not write its own home — measured `EACCES` — and could
  // write a sibling's. One credential, both surfaces.
  //
  // This is the unmounted workspace tree retained by memory and agent-state
  // services. Snapshot walks start at a relative workspace root, which the
  // mount table never augments, so foreign bytes stay out of both boundaries.
  const baseWorkspaceVfs = nimbusSessionFiles(workspaceBox, hooks.workspaceExecution?.cred);
  const observedWorkspaceVfs = hooks.workspaceObserver
    ? observeWrites(baseWorkspaceVfs, hooks.workspaceObserver)
    : baseWorkspaceVfs;

  // MemoryStore from agent-utils — FTS5-indexed search over the workspace
  // filesystem itself, so `memory/MEMORY.md` is the same file the agent reads
  // with the `file` tool and greps in the shell.
  const memoryStore = new MemoryStore(baseWorkspaceVfs, sql);
  memoryStore.ensureSchema();

  // Vectorize-backed semantic memory, scoped to this workspace's namespace.
  // Noop when env.AI / env.MEMORY_VECTORS aren't configured, so hybrid search
  // degrades to FTS5-only. Built before the memory adapter so writes embed.
  const vectorStore = buildVectorStore(env, actor, hooks.reportModelCall);
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
  // The rest of what a runtime's own storage carries, for the same reason and
  // by the same measurement: `agent_config` was the first table an exploration
  // facet was found to be missing, not the only one. The workspace executor
  // registered below is handed this same `sql`, and its `listTools` quotes the
  // crafted-tool quality columns ON `crafted_tools`, its `createTool` seeds
  // that row and files a refused one in `evolution_events`, and its view tools
  // write `agent_views` — so a head missing those tables on its first
  // `workspace.listTools()`, and a tool it crafted was written and then
  // reported to the model as a failure. `initActorTables` is the declared set
  // for storage that belongs to one full-loop actor and carries no workspace
  // identity or fork lineage of its own, which is exactly a facet's; on a root
  // it is the idempotent prefix of the `initWorkspaceSchema` its attach runs.
  initActorTables(execRaw, sql);
  const memoryConfig = createAgentConfigStore(sql);

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
  // Every non-turn model lane this runtime carries, off ONE binding of the
  // three inputs they all resolve from (see `createProfileLaneLLM`): the four
  // call sites used to repeat that binding, and the reflection one repeated the
  // whole factory beside it.
  const profileLane = (source: FixedTierSource): LLM | undefined => createProfileLaneLLM(
    agent, env, actor, hooks.turnProfile, hooks.resolveProfile, source, hooks.reportModelCall,
  );
  // The one REQUIRED lane. `judgeModel`/`fastLlm`/`advisorLlm` may be absent —
  // a caller that finds one missing skips that lane — but `AgentRuntime.llm` is
  // not optional, so a runtime built with no profile hooks at all still carries
  // it and says so at USE, exactly as it always has.
  const llm: LLM = profileLane('reflection') ?? {
    async *stream() { yield ""; },
    async complete(): Promise<string> {
      throw new Error('reflection model lane has no active profile');
    },
  };
  const schedule = createRealSchedule(agent);
  const identity = createIdentity(agent, access.ctx, observedWorkspaceVfs, sql, actor.scaffoldPath);

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
  // The shell is the authoritative Nimbus session's direct shell over the base
  // tree. It deliberately never receives the VFS-only `/pc` or `/sandbox`
  // mounts; only file operations can cross those executor boundaries.
  const shell = withApprovalGatedShell(nimbusSessionShell(executionBox), approvalPolicy);
  const executionRouter: ExecutionRouter = new DefaultExecutionRouter(approvalPolicy);
  // The agent's ONE file plane extends the observed workspace tree with `/pc`
  // for a connected device and `/sandbox` for the bound container, resolved
  // live from this router on every call. The `file` tool and `workspace.*`
  // reach foreign machines through this same object; state services above keep
  // `baseWorkspaceVfs`, because they must never snapshot or index foreign
  // bytes.
  const agentFileVfs = withMountTable(
    observedWorkspaceVfs,
    standardMounts((name) => executionRouter.getProvider(name)),
  );
  executionRouter.register(createNimbusWorkspaceExecutor({
    box: executionBox,
    // FALSE, with the bucket bound. `runtimeCatalog` declares that this
    // deployment can INSTALL AND RUN an interpreter runtime; a workspace held
    // as a library in the actor's own Durable Object can fetch one out of
    // NIMBUS_RUNTIME_CACHE and cannot run it — a wasm guest needs a facet
    // substrate that compiles and enters a module, which on workerd is the
    // dynamic-worker pool a Nimbus SESSION object composes for itself. So
    // `python`/`native_binary` are not declared, `runtimes.*` still reaches the
    // bucket, and `python3` is "command not found" rather than a command that
    // installs 35.7 MB of rows and then fails.
    runtimeCatalog: false,
    inboundNetwork: nimbusPreviewConfigured(env),
    inline: {
      vfs: agentFileVfs, memory, craftStore, shell,
      // sql is used by workspace.listTools() to read the crafted tools' EMA
      // quality columns.
      sql,
      // Optional eager notification; the execute_tools sandbox live-reads CraftStore.
      onToolRegistered: hooks.onToolRegistered,
      // Shares the native `file` tool's turn ledger/budget with workspace.*
      // (editFile's gate, readFile/writeFile's observe). The thunks are passed
      // unconditionally and read the supplied turn accumulator only when called.
      ledger: () => access.acc?.().files,
      budget: () => access.acc?.().context,
    },
  }));
  // Register Sandbox executor — Kinu's primary remote exec surface.
  // Backed by @cloudflare/sandbox: one Linux container per agent, keyed
  // by the agent's stable name. `PREVIEW_HOST_SUFFIX` is the zone the SDK
  // builds preview URLs on — `<port>-<sandbox>-<token>.<suffix>`, routed back
  // by preview-proxy.ts. `sandboxId` is the stable DO key those URLs carry.
  const previewSuffix = previewHostSuffix(env) ?? undefined;
  const sandboxId = sandboxIdForWorkspace(actor.workspaceName);
  let sandboxHandle: SandboxHandle | null = null;
  if (env.Sandbox) {
    try {
      // {@link SANDBOX_TRANSPORT} is the SDK's primary container-control path: one
      // capnweb RPC session over a WebSocket, against the container's own
      // control plane. `http` and `websocket` select the ROUTE-BASED
      // COMPATIBILITY CLIENT, which Cloudflare deprecated on 2026-06-09 —
      // "HTTP and WebSocket transports are deprecated and will not ship in
      // future Sandbox SDK majors" — and which cannot restore a workspace.
      // MEASURED against a real 0.12.7 container: `restoreBackup` of
      // /workspace is the SDK's only transport-branching path we take
      // (localBucket, so doRestoreBackupLocal), and on `websocket` it buffers
      // the whole archive as an ArrayBuffer plus a base64 copy in this
      // isolate. Restores of an 8/9/10/11 MiB payload land; 12, 16, 20, 24 and
      // 32 MiB every one fails with `WebSocket closed: 1011 Container
      // WebSocket error` and leaves /workspace empty. The ceiling is base64
      // expansion against a 16 MiB frame: 12 MiB x 4/3 is exactly 16 MiB. On
      // `rpc` the same restores stream (writeFileStream) and all five sizes
      // land, 32 MiB in 1045 ms.
      //
      // It must be passed identically on EVERY getSandbox() for an id —
      // changing it mid-life disconnects the active client and drops in-flight
      // requests. That is why the value is {@link SANDBOX_TRANSPORT} rather
      // than a literal repeated at each site (see orchestrator.ts's teardown
      // lookup, terminal-route.ts and preview-proxy.ts). The option cannot be
      // dropped in favour of the SANDBOX_TRANSPORT var alone: the SDK PERSISTS
      // transport in the sandbox object's own storage and a stored value beats
      // the env-derived default on every cold start, so an existing sandbox
      // stays on whatever it was last told. The var is set as well, so a future
      // getSandbox that forgets this option inherits `rpc` rather than the
      // SDK's `http` field default.
      const sdk = getSandbox(env.Sandbox, sandboxId, {
        normalizeId: true, transport: SANDBOX_TRANSPORT,
      });
      // Egress interception is configured before the container can run
      // anything, by the Durable Object that owns it, and awaited inside the
      // operation that needed it. Not in `onStart`: the Container base
      // re-applies its persisted outbound configuration immediately BEFORE
      // `container.start()`, and `onStart` runs after the container is already
      // up, so the hook is too late to install it. Until it lands the container
      // has no network at all — `enableInternet = false` with no handler bound
      // means the platform denies everything — so the window before
      // configuration fails closed rather than leaking an unintercepted
      // request. Only the workspace that OWNS the grants configures; a facet
      // rides the configuration its root installed.
      //
      // `sdk.configureEgress` rather than binding the handlers from here: that
      // call is also what pins WHICH workspace owns the container, which is how
      // a lifecycle incident reaches its agent from a cold, evicted object.
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
      // Where this box's published previews live. `AUTH_KV` is the Worker's own
      // store, so the edge can prove a preview hostname without asking any
      // per-name Durable Object — asking the object would create the object the
      // question is about. Absent binding, port exposure refuses rather than
      // minting a URL the edge would turn away.
      env.AUTH_KV ? sandboxPreviewExposures(env.AUTH_KV, sandboxId) : null);
      sandboxHandle = handle;
      // No restore wrapper here, deliberately. Restoring /workspace is the
      // container's own affair and happens in KinuSandbox.onStart, inside the
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
  // These independent maintenance operations belong to the runtime they warm:
  // retaining one non-rejecting promise keeps synchronous construction cheap
  // without dropping work after the factory returns. Turn start still awaits
  // its authoritative device-status refresh below.
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
  // The executor's file view scopes paths to the ONE directory the owner named
  // at `kinu connect`, unless the owner turned this device's Sandbox switch
  // OFF, which lifts the view for the same reason it lifts the shell: one
  // switch, both enforcers. The binding (ask-once-then-remember) still applies
  // to every RPC beneath.
  //
  // A CLI turn answers with its own cwd, which is the machine the CLI runs on
  // and needs no tunnel. Everything else reads the connected device's row: the
  // daemon reported both paths on HELLO, so neither is computed here and
  // neither costs a command on the user's machine.
  //
  // A hub read that FAILS is rethrown with its cause, never answered as
  // "no directory" or "sandbox on": every consumer is a file operation that
  // fails closed either way, and only the rethrow tells the model the truth —
  // the device DID name a directory, and the hub could not be asked. A null
  // scope would have it advise the owner to reconnect a machine that is fine.
  //
  // Per MACHINE: the fleet snapshot carries each live machine's own paths, and
  // a question that names one is answered from that machine's entry. An
  // unnamed question keeps the one-machine answer the snapshot's top level
  // carries, which is absent — null — once several machines are live.
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
    unconfined: async (deviceId) => {
      const hub = userDOStubFor(env, actor);
      if (!hub) return false;
      try {
        return (await hub.getDeviceFileView(await userCallerFor(actor), actor.workspaceName, deviceId)).unconfined;
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
    storage: { vfs: agentFileVfs, sql, execRaw },
    agentStateVfs: baseWorkspaceVfs,
    startupWork,
    memory, executor, llm, schedule, identity, craftStore,
    get judgeModel() { return profileLane('judge'); },
    get fastLlm() { return profileLane('fast'); },
    get advisorLlm() { return profileLane('advisor'); },
    spawnBranch: createFacetSpawner(agent, env, actor),
    abortBranch: createFacetAborter(agent),
    releaseBranch: createFacetReleaser(agent),
    executionRouter,
    shell,
    localVfs: baseWorkspaceVfs,
    deviceTransport,
    vectorStore,
    sandboxHandle,
  };
  return runtime;
}

// ── Adapters: agent-utils → core interfaces ──────────────────────
// adaptMemory + backfillMemoryVectors live in ./memory-sync (dependency-light,
// unit-tested against a fake VectorStore).

/** The workspace's semantic-memory embedder. Named because the two construction
 *  shapes below both reach for it, and a copy in each is a model id two places
 *  could disagree about. */
const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';

/**
 * Build the workspace's semantic memory store. Constructs a Cloudflare-Vectorize
 * store (scoped to this workspace's namespace) only when both env.AI (Workers AI
 * embedder) and env.MEMORY_VECTORS (Vectorize index) are bound; otherwise a noop
 * that makes hybrid search degrade to FTS5-only.
 */
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
      // Shared index across all of the user's workspaces — scope every write
      // and query to this workspace so memories never leak across agents.
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
        return { result: undefined, error: renderThrownChain({ cause: e }) };
      }
    },
  };
}


/**
 * The actor's provider registry — one builder for every non-turn model seam.
 *
 * Each seam carried its own copy of this call and all of them resolved it from the
 * same three inputs: this Worker's env, the owner's UserDO under this actor's
 * capability, and this agent's Workers-AI affinity key. `title` is the only real
 * difference and it is one request header (OpenRouter's `X-Title`), so it is an
 * argument rather than a reason for four literals.
 *
 * Resolved at CALL time by every caller, which is what the copies were
 * inconsistent about: a registry captured when the runtime was built cannot see a
 * provider the owner connected since, and each seam promises a provider switch
 * takes effect without a redeploy. Deliberately NOT routed through
 * `OwnedModelServices`, which memoizes under one fixed title — right for the turn's
 * model, wrong here.
 */
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
    workersAI: { sessionAffinity: agentAffinityKey(agent.name) },
  });
}

/** One shape for every lane the factory below builds, so a source label and a
 *  spec cannot be attached one way for one lane and another way for the next. */
function reportCall(
  report: ModelCallSink | undefined,
  source: SpendSource,
  spec: string,
  result: { usage?: LanguageModelUsage; response?: { modelId?: string } },
): void {
  if (!report) return;
  const usage = normalizeUsage(result.usage);
  const modelId = result.response?.modelId;
  // Two whole literals rather than one built up: `modelId` is absent when the
  // provider did not name the model, and absent has to mean absent.
  report(modelId !== undefined && modelId.length > 0
    ? { source, spec, usage, modelId }
    : { source, spec, usage });
}

/** Build one fixed-tier lane from the active immutable profile — every non-turn
 *  model seam this runtime has, including the reflection lane that used to
 *  carry a byte-identical copy of this factory beside it.
 *
 *  `source` is core's `FixedTierSource`, derived from MODEL_ROUTE_POLICY's
 *  fixed rows. It used to be a local `'judge' | 'fast' | 'advisor'` union — a
 *  hand-mirror of a SUBSET of those rows, so moving a producer onto a fixed tier
 *  in core left this factory unable to name it and nothing said so.
 *
 *  Only a COMPLETED call reports. A seam that threw produced no usage and, as
 *  far as anything here can see, was not billed — counting it as an unmeasured
 *  call would depress the workspace's coverage fraction with requests that
 *  genuinely cost nothing. */
function createProfileLaneLLM(
  agent: AgentHost,
  env: Env,
  actor: ActorRuntimeIdentity,
  turnProfile: (() => ResolvedTurnProfile | null) | undefined,
  resolveProfile: (() => Promise<ResolvedTurnProfile>) | undefined,
  source: FixedTierSource,
  report?: ModelCallSink,
): LLM | undefined {
  if (!turnProfile && !resolveProfile) return undefined;
  return {
    async *stream() { yield ""; },
    async complete(prompt: string): Promise<string> {
      const profile = turnProfile?.() ?? await resolveProfile?.();
      if (!profile) throw new Error(`${source} model lane has no active profile`);
      const route = resolveModelRoute(source, profile);
      if (!route) throw new Error(`${source} cannot use the fixed platform model route`);
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
    // Core's ONE scaffold surface (scaffold/surface.ts): `.vN` files are the
    // canonical source, `scaffold_versions.status='current'` is the single
    // current pointer, and exists()/read() resolve POINTER-FIRST so a stale
    // live view is healed by the next activation instead of served.
    scaffold: createScaffoldSurface({ vfs, sql, path: scaffoldPath }),
  };
}

// ── MCTS branches via real Facets (spawn seam: facet-spawn.ts) ───

function createFacetSpawner(agent: AgentHost, env: Env, actor: ActorRuntimeIdentity): (branchId: string) => Promise<BranchHandle> {
  return async (branchId: string): Promise<BranchHandle> => {
    try {
      return await spawnBranchFacet(agent, branchId, {
        ownerUserId: actor.ownerUserId(),
        capabilityToken: await actor.capabilityToken(),
        // Without this a branch has no parent stub, so it cannot reach the
        // profile that decides its tier — and `mcts` is `invocation`-routed, so
        // every branch ran the account default at an effort nothing chose while
        // the turn it belongs to may be on any tier its role selected. It grants
        // no runtime: containment stays with the branch never calling
        // `facetRuntime()`, which unit-exploration-containment.test.ts pins.
        sharedParent: actor.workspaceName,
      });
    } catch (err) {
      diagnostics.failure('mcts.branch_facet_spawn_failed', toKinuError({
        doing: 'spawning a branch facet',
        cause: err,
        otherwise: 'unavailable',
      }), { branchId });
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
 * produce silence at exactly the moment a database was stranded. A leaked facet
 * database spends the quota whose overflow resets the whole workspace.
 */
function createFacetReleaser(agent: AgentHost): (branchId: string) => Promise<void> {
  return async (branchId: string) => {
    try {
      await deleteExplorationFacet(agent, branchId);
    } catch (err) {
      diagnostics.failure('mcts.branch_facet_storage_leaked', toKinuError({
        doing: "reclaiming a branch facet's storage",
        cause: err,
        otherwise: 'io',
      }), { branchId });
    }
  };
}

/**
 * Inline branch fallback — used when Facets are unavailable.
 *
 * Storage isolation (lean/Kinu/MCTS/StorageIsolation.lean: branch storage
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
    appTitle: 'Kinu (inline branch)',
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
    // No trace table on this path — the reflection is about the task and the
    // environment's verdict alone, and the shared prompt drops the attempt
    // heading rather than showing an empty one.
    generateReflection: async (task, outcome) => {
      const result = await generateText({
        model: getModel(),
        messages: [{ role: "user" as const, content: reflectionPrompt(task, '', outcome) }],
        ...effortFor('reflection'),
      });
      return { text: result.text.trim(), usage: normalizeUsage(result.usage) };
    },
  };
}
