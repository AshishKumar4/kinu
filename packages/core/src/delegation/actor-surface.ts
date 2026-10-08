/**
 * An actor's namespaces, built once for every caller on every backend: its own programs, a caller outside eval acting
 * as it, a slate's call, a crafted tool a slate runs, and a confined copy's program. How each caller differs is its
 * policy, declared in `SURFACE_POLICY`; nothing else assembles a namespace list, so a role names, narrows and reaches
 * the one list everywhere.
 */
import type { ExecutorProviderSurface } from '../execution/types';
import type { AgentConfigStore } from '../config/store';
import type { ConversationRecall } from '../memory/conversation-search';
import type { VectorStore } from '../memory/vector-store';
import type { AccountMemory } from '../memory/account';
import type { ProgramStateStore } from '../identity/program-state';
import type { HostedActor } from '../state/actor-host';
import type { Storage } from '../types/primitives';
import type { CodemodeProvider } from '../types/codemode';
import type { BrowserSessions, WebSearchProvider } from '../web/provider';
import { createAgentSelfProvider, type AgentSelfHost } from '../tools/agent-self';
import { createDbCodemodeProvider, type AppDataStore } from '../tools/db-codemode';
import { executorNamespace } from '../tools/executor-operations';
import { createFileCodemodeProvider, type FileDeps } from '../tools/file-operations';
import { createMemoryCodemodeProvider, type MemoryDeps } from '../tools/memory-operations';
import { createReportCodemodeProvider, type ReportDeps } from '../tools/report-operations';
import { createStateCodemodeProvider } from '../tools/state-operations';
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
  /** Its stores, read only by a policy that reaches them. */
  readonly memory: () => MemoryDeps;
  readonly files: () => FileDeps;
  /** `roleSwitch` null: its programs switch no role, as a hire's role is its hirer's to set. */
  readonly tasks: () => { readonly list: TaskListStore; readonly config: AgentConfigStore; readonly roleSwitch: RoleSwitch | null };
  readonly db: AppDataStore;
  readonly programState: ProgramStateStore;
  /** Null for an actor with no inbox of its own to delegate from. */
  readonly agents: (() => AgentsToolDeps) | null;
  /** `agent.*`, its own lifecycle: the workspace's main actor only. */
  readonly self: AgentSelfHost | null;
}

/** How a caller's namespaces differ from the actor's own programs'. */
export interface SurfacePolicy {
  readonly state: boolean;
  readonly agents: boolean;
  /** `memory`, `file` and `tasks`. */
  readonly stores: boolean;
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
  /** The actor's own programs. */
  program: { state: true, agents: true, stores: true, webFiles: true, browser: 'program', account: true },
  /** A caller outside eval acting as the actor: an isolate running its turn, an operation call. */
  operations: { state: true, agents: true, stores: true, webFiles: true, browser: 'class', account: true },
  /** A slate's call, which a share's visitor may make: it saves nothing through web, delegates nothing and keeps no state. */
  slate: { state: false, agents: false, stores: true, webFiles: false, browser: 'class', account: false },
  /** The owner's own slate calling as the owner, no share in it: a slate's reach, and it hires and messages helpers. */
  ownerSlate: { state: false, agents: true, stores: true, webFiles: false, browser: 'class', account: false },
  /** A crafted tool a slate runs: a program of the actor's that delegates nothing, driving its caller's browser. */
  slateTool: { state: true, agents: false, stores: true, webFiles: true, browser: 'program', account: false },
  slateToolForViewer: { state: true, agents: false, stores: true, webFiles: true, browser: 'viewer', account: false },
  /**
   * A confined copy's program (a head, a swarm node, a hosted task turn): its memory, files and tasks reach it as its
   * native tools, and it delegates through them, never from a program.
   */
  confined: { state: true, agents: false, stores: false, webFiles: true, browser: 'program', account: false },
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

export function actorNamespaces(actor: SurfaceActor, policy: SurfacePolicy, call: SurfaceCall = {}): CodemodeProvider[] {
  const { agents, self } = actor;
  const executor = call.executor ?? ((provider) => provider);
  const tasks = policy.stores ? actor.tasks() : null;

  return [
    ...(policy.state ? [createStateCodemodeProvider(actor.programState)] : []),
    ...(policy.agents && agents !== null ? [createAgentsCodemodeProvider(agents)] : []),
    ...(tasks === null ? [] : [
      createMemoryCodemodeProvider(policy.account ? actor.memory : () => withoutAccount(actor.memory())),
      createFileCodemodeProvider(actor.files),
      createTasksCodemodeProvider(tasks.list, tasks.config, tasks.roleSwitch ?? undefined),
    ]),
    createDbCodemodeProvider(actor.db),
    ...(self === null ? [] : [createAgentSelfProvider(self)]),
    ...(call.report === undefined ? [] : [createReportCodemodeProvider(call.report)]),
    webFor(actor.web, policy),
    ...actor.executors().map((provider) => executorNamespace(executor(provider))),
  ];
}

/** Any hosted actor, as every backend describes it: over its own runtime and stores, with no role of its own to switch. */
export function hostedSurfaceActor(
  actor: HostedActor,
  inputs: { readonly web: SurfaceWeb; readonly conversations: ConversationRecall; readonly vectorStore: VectorStore | null; readonly account?: AccountMemory },
): SurfaceActor {
  const { runtime, stores, session } = actor;
  const { account } = inputs;

  return {
    executors: () => runtime.executionRouter?.getProviders() ?? [],
    web: inputs.web,
    memory: () => ({
      memory: runtime.memory, vectorStore: inputs.vectorStore, facts: stores.facts, actor: actor.handle, conversations: inputs.conversations,
      ...(account !== undefined && { account }),
    }),
    files: () => ({
      vfs: runtime.toolFiles, home: runtime.storage.home, planes: runtime.planes, memory: runtime.memory,
      ledger: session.orchestrator.acc.files, budget: session.orchestrator.acc.context,
    }),
    tasks: () => ({ list: stores.taskList, config: stores.config, roleSwitch: null }),
    db: stores.appData,
    programState: runtime.actor.programState,
    agents: null,
    self: null,
  };
}
