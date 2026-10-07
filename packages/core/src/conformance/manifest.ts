/**
 * Backend conformance manifest: for each capability, each composition root
 * either wires it or names why not. Per-root conformance tests compare this
 * against the real composition output in both directions. Test-plane only.
 */

import { AGENTS_TOOL_ACTIONS, BUILTIN_TOOLS, MEMORY_FACT_ACTIONS, MEMORY_NOTE_ACTIONS } from '../tools/registry';
import type { AgentsToolAction, BuiltinToolName, MemoryToolAction } from '../tools/registry';
import type { SpendSource } from '../events/model-call';

/**
 * Producers a root builds unconditionally. `fast` is excluded: whether it
 * exists depends on the workspace's model (vendor smaller tier), not the backend.
 */
export const CONFORMANCE_PRODUCERS = ['judge'] as const satisfies readonly SpendSource[];

export type ConformanceProducer = (typeof CONFORMANCE_PRODUCERS)[number];

/** cf splits by actor profile because the profiles differ (`actorToolDeps`). */
export const CONFORMANCE_ROOTS = ['cf-orchestrator', 'cf-subordinate', 'cli'] as const;

export type ConformanceRoot = (typeof CONFORMANCE_ROOTS)[number];

/** Wired, or absent for a stated reason. No state for "forgot". */
export type CapabilityStatus =
  | { readonly wired: true }
  | { readonly absent: string };

export const WIRED: CapabilityStatus = { wired: true };

export type RootStatuses = Readonly<Record<ConformanceRoot, CapabilityStatus>>;

const EVERYWHERE = { 'cf-orchestrator': WIRED, 'cf-subordinate': WIRED, cli: WIRED } satisfies RootStatuses;

export const CONFORMANCE_PLANES = ['tool', 'agents-action', 'memory-action', 'producer'] as const;

export type ConformancePlane = (typeof CONFORMANCE_PLANES)[number];

export interface ConformanceManifest {
  /** Keyed by the registry union, so a new tool cannot compile without a per-root decision. */
  readonly tool: Readonly<Record<BuiltinToolName, RootStatuses>>;
  readonly 'agents-action': Readonly<Record<AgentsToolAction, RootStatuses>>;
  readonly 'memory-action': Readonly<Record<MemoryToolAction, RootStatuses>>;
  /** Model producers whose client the root actually built. */
  readonly producer: Readonly<Record<ConformanceProducer, RootStatuses>>;
}

const ORCHESTRATOR_IS_SINK = 'the orchestrator IS the report sink; only subordinate actors report upward';

/** Subordinates hold the parent's roster surface, bounded by DELEGATION_MAX_DEPTH;
 *  "wired" means wired wherever depth remains. */
const TEAM_RECURSES = {
  'cf-orchestrator': WIRED,
  'cf-subordinate': WIRED,
  cli: WIRED,
} satisfies RootStatuses;

export const BACKEND_CONFORMANCE: ConformanceManifest = {
  tool: {
    eval: EVERYWHERE,
    shell: EVERYWHERE,
    file: EVERYWHERE,
    agents: EVERYWHERE,
    memory: EVERYWHERE,
    tasks: EVERYWHERE,
    web: EVERYWHERE,
    report: {
      'cf-orchestrator': { absent: ORCHESTRATOR_IS_SINK },
      'cf-subordinate': WIRED,
      cli: { absent: ORCHESTRATOR_IS_SINK },
    },
  },

  'agents-action': {
    // A swarm needs only a model and a workspace, so it has no deps group to under-wire.
    swarm: EVERYWHERE,
    hire: TEAM_RECURSES,
    // A subordinate has no peer transport: `hire scope=workspace` would let it escape its
    // subtree (delegation/agents-tool.ts). Locally every root agent gets PeerHub.
    msg: TEAM_RECURSES,
    list: TEAM_RECURSES,
    dismiss: TEAM_RECURSES,
  },

  'memory-action': {
    save: EVERYWHERE,
    search: EVERYWHERE,
    conversations: EVERYWHERE,
    remember: EVERYWHERE,
    recall: EVERYWHERE,
    forget: EVERYWHERE,
  },

  producer: {
    // On the CLI without a second model, core's same-model fallback runs.
    judge: {
      'cf-orchestrator': WIRED,
      'cf-subordinate': WIRED,
      cli: WIRED,
    },
  },
};

/** An omitted plane is reported unmeasured, never treated as conformant. */
export interface ObservedSurface {
  readonly root: ConformanceRoot;
  readonly planes: Partial<Record<ConformancePlane, ReadonlySet<string>>>;
}

/** Registry-closed planes, to tell "undeclared" from impossible states. */
export const PLANE_UNIVERSE = {
  tool: BUILTIN_TOOLS,
  'agents-action': AGENTS_TOOL_ACTIONS,
  'memory-action': [...MEMORY_NOTE_ACTIONS, ...MEMORY_FACT_ACTIONS],
  producer: CONFORMANCE_PRODUCERS,
} satisfies Partial<Record<ConformancePlane, readonly string[]>>;
