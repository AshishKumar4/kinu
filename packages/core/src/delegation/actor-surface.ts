/**
 * An actor's namespaces, built once for every caller on every backend: its own programs, a caller outside eval acting
 * as it, a slate's call, a crafted tool a slate runs, and a hire's, head's or node's program. How each caller differs is its
 * policy, declared in `SURFACE_POLICY`; nothing else assembles a namespace list, so a role names, narrows and reaches
 * the one list everywhere.
 */
import type { ExecutorProviderSurface } from '../execution/types';
import type { AgentConfigStore } from '../config/store';
import type { ConversationRecall } from '../memory/conversation-search';
import type { VectorStore } from '../memory/vector-store';
import type { AccountMemory } from '../memory/account';
import type { SeatedActor } from '../state/actor-host';
import type { TurnLedgers } from '../orchestrator/turn-accumulator';
import type { Storage } from '../types/primitives';
import type { CodemodeProvider } from '../types/codemode';
import type { BrowserSessions, WebSearchProvider } from '../web/provider';
import { createAgentSelfProvider, createHireOwnerWaitsProvider, type AgentSelfHost, type OwnerWaitsHost } from '../tools/agent-self';
import { createDbCodemodeProvider, type AppDataStore } from '../tools/db-codemode';
import { executorNamespace } from '../tools/executor-operations';
import { createFileCodemodeProvider, serveFile, type FileDeps } from '../tools/file-operations';
import { createMemoryCodemodeProvider, type MemoryDeps } from '../tools/memory-operations';
import { createReportCodemodeProvider, type ReportDeps } from '../tools/report-operations';
import { createTasksCodemodeProvider, type RoleSwitch } from '../tools/tasks-operations';
import type { TaskListStore } from '../tools/task-store';
import { createWebCodemodeProvider } from '../tools/web-operations';
import { createAgentsCodemodeProvider } from './agents-operations';
import type { AgentsToolDeps } from './agents-tool';

/** Where an actor's web reaches. */
export interface SurfaceWeb {
  readonly search: WebSearchProvider;
  /** Where a screenshot is saved, when the caller's policy saves one. */
  readonly files: Pick<Storage, 'vfs' | 'home'>;
  /** The actor's own Chrome sessions and the sandbox module that drives one; null where no program reaches a browser. */
  readonly browser: { readonly sessions: BrowserSessions; readonly prelude: string } | null;
}

/** One actor as every caller's namespaces are built over it. Read per build: executors attach and detach. */
export interface SurfaceActor {
  readonly executors: () => readonly ExecutorProviderSurface[];
  readonly web: SurfaceWeb;
  /** Its stores, read as its namespaces are built. */
  readonly memory: () => MemoryDeps;
  readonly files: () => FileDeps;
  /** `roleSwitch` null: its programs switch no role, as a hire's role is its hirer's to set. */
  readonly tasks: () => { readonly list: TaskListStore; readonly config: AgentConfigStore; readonly roleSwitch: RoleSwitch | null };
  readonly db: AppDataStore;
  /** Null for an actor with no inbox of its own to delegate from. */
  readonly agents: (() => AgentsToolDeps) | null;
  /** `agent.*`, its own lifecycle: the workspace's main actor only. */
  readonly self: AgentSelfHost | null;
  /** A hire's `agent.*`: what waits on its owner from its own work, and its wake; null for an actor with neither. */
  readonly ownerWaits: OwnerWaitsHost | null;
}

/** How a caller's namespaces differ from the actor's own programs'. */
export interface SurfacePolicy {
  /** Whether it reaches the agent's private tables (`db` scope `private`): never a slate's call, nor a crafted tool a
   *  slate runs, whoever's slate it is. */
  readonly private: boolean;
  readonly agents: boolean;
  /** Whether a web screenshot is saved into the actor's files. */
  readonly webFiles: boolean;
  /** Whether its `memory.*` reaches the account's memory, where the actor's has it wired: never from a slate, whose
   *  calls a share's viewer may make. */
  readonly account: boolean;
  /**
   * The browser a call drives: a program's own sessions, none (a share's viewer drives none of its owner's), or a
   * slate's class, for a call that runs no program.
   */
  readonly browser: 'program' | 'viewer' | 'class';
}

export const SURFACE_POLICY = {
  /** The actor's own programs, a hire's, a head's or a swarm node's alike: each reaches what its actor holds, as its
   *  native tools do. */
  program: { private: true, agents: true, webFiles: true, browser: 'program', account: true },
  /** A caller outside eval acting as the actor: an isolate running its turn, an operation call. */
  operations: { private: true, agents: true, webFiles: true, browser: 'class', account: true },
  /** A slate's call, which a share's visitor may make: it saves nothing through web, delegates nothing and reaches no private table. */
  slate: { private: false, agents: false, webFiles: false, browser: 'class', account: false },
  /** The owner's own slate calling as the owner, no share in it: a slate's reach, and it hires and messages helpers. */
  ownerSlate: { private: false, agents: true, webFiles: false, browser: 'class', account: false },
  /** A crafted tool a slate runs: a program of the actor's that delegates nothing, driving its caller's browser. */
  slateTool: { private: false, agents: false, webFiles: true, browser: 'program', account: false },
  slateToolForViewer: { private: false, agents: false, webFiles: true, browser: 'viewer', account: false },
} as const satisfies Readonly<Record<string, SurfacePolicy>>;

const VIEWER_BROWSER = 'this program holds no browser session; a share\'s viewer drives none of its owner\'s';

const CLASS_BROWSER = 'a slate drives a browser from its class (this.env.workspace.web.connectBrowser); its page asks the class';

export interface SurfaceCall {
  /** Each executor as this call's programs reach it: an eval binds its own calls' context here. */
  readonly executor?: (provider: ExecutorProviderSurface) => ExecutorProviderSurface;
  /** `report.*`, on a turn its parent drives. */
  readonly report?: () => ReportDeps;
}

/** An actor's stores as a caller that never reaches the account sees them: its `memory.*` names no scope. */
function withoutAccount(deps: MemoryDeps): MemoryDeps {
  return { ...deps, account: undefined };
}

function webFor(web: SurfaceWeb, policy: SurfacePolicy): CodemodeProvider {
  const files = policy.webFiles ? web.files : null;

  if (web.browser === null) return createWebCodemodeProvider({ provider: web.search, files });

  if (policy.browser === 'viewer') return createWebCodemodeProvider({ provider: web.search, files, prelude: { missing: VIEWER_BROWSER } });

  return createWebCodemodeProvider({
    provider: web.search, files, sessions: web.browser.sessions,
    prelude: policy.browser === 'program' ? { source: web.browser.prelude } : { missing: CLASS_BROWSER },
  });
}

/** `agent.*`: the workspace agent's whole lifecycle, else a hire's own waits on its owner, else none. */
function agentNamespace(self: AgentSelfHost | null, ownerWaits: OwnerWaitsHost | null): CodemodeProvider[] {
  if (self !== null) return [createAgentSelfProvider(self)];

  return ownerWaits === null ? [] : [createHireOwnerWaitsProvider(ownerWaits)];
}

export function actorNamespaces(actor: SurfaceActor, policy: SurfacePolicy, call: SurfaceCall = {}): CodemodeProvider[] {
  const { agents, self } = actor;
  const executor = call.executor ?? ((provider) => provider);
  const tasks = actor.tasks();
  // Every machine's `fs` is the actor's own `file` operations, on that machine's root in its plane.
  const files = serveFile(actor.files);

  return [
    ...(policy.agents && agents !== null ? [createAgentsCodemodeProvider(agents)] : []),
    createMemoryCodemodeProvider(policy.account ? actor.memory : () => withoutAccount(actor.memory())),
    createFileCodemodeProvider(actor.files),
    createTasksCodemodeProvider(tasks.list, tasks.config, tasks.roleSwitch ?? undefined),
    createDbCodemodeProvider(actor.db, { private: policy.private }),
    ...agentNamespace(self, actor.ownerWaits),
    ...(call.report === undefined ? [] : [createReportCodemodeProvider(call.report)]),
    webFor(actor.web, policy),
    ...actor.executors().map((provider) => executorNamespace(executor(provider), files)),
  ];
}

/** Any hosted actor, as every backend describes it: over its own runtime and stores, with no role of its own to switch. */
export function hostedSurfaceActor(
  actor: SeatedActor,
  inputs: {
    readonly web: SurfaceWeb; readonly conversations: ConversationRecall; readonly vectorStore: VectorStore | null; readonly account?: AccountMemory;
    /** Its `agent.*` of what waits on its owner from its own work; null where none is held for it. */
    readonly ownerWaits: OwnerWaitsHost | null;
    /** What its native `agents` delegates through, where it delegates; its programs delegate through the same. */
    readonly agents?: () => AgentsToolDeps;
    /** The turn a program's files account into: read as its namespaces are built. */
    readonly ledgers: () => Pick<TurnLedgers, 'files' | 'context'>;
    /** Whether a slate still builds, for a write its programs make into one; absent where no slate host builds it. */
    readonly slateBuild?: FileDeps['slateBuild'];
  },
): SurfaceActor {
  const { runtime, stores } = actor;
  const { account } = inputs;

  return {
    executors: () => runtime.executionRouter?.getProviders() ?? [],
    web: inputs.web,
    memory: () => ({
      memory: runtime.memory, vectorStore: inputs.vectorStore, facts: stores.facts, actor: actor.handle, conversations: inputs.conversations,
      ...(account !== undefined && { account }),
    }),
    files: () => {
      const ledgers = inputs.ledgers();

      return {
        vfs: runtime.toolFiles, home: runtime.storage.home, planes: runtime.planes, memory: runtime.memory, ledger: ledgers.files, budget: ledgers.context,
        ...(inputs.slateBuild !== undefined && { slateBuild: inputs.slateBuild }),
      };
    },
    tasks: () => ({ list: stores.taskList, config: stores.config, roleSwitch: null }),
    db: stores.appData,
    agents: inputs.agents ?? null,
    self: null,
    ownerWaits: inputs.ownerWaits,
  };
}
