/**
 * Backend conformance manifest: for each capability, each composition root
 * either wires it or names why not. Per-root conformance tests compare this
 * against the real composition output in both directions. Test-plane only.
 */

import { BUILTIN_TOOLS } from '../tools/registry';
import type { BuiltinToolName } from '../tools/registry';
import { AGENTS_OPS, type AgentsOp } from '../operations/agents';
import { MEMORY } from '../operations/memory';
import type { SpendSource } from '../events/model-call';

/**
 * Producers a root builds unconditionally. `fast` is excluded: whether it
 * exists depends on the workspace's model (vendor smaller tier), not the backend.
 */
export const CONFORMANCE_PRODUCERS = ['judge'] as const satisfies readonly SpendSource[];

type ConformanceProducer = (typeof CONFORMANCE_PRODUCERS)[number];

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

export const CONFORMANCE_PLANES = ['tool', 'agents-op', 'memory-op', 'producer'] as const;

export type ConformancePlane = (typeof CONFORMANCE_PLANES)[number];

export interface ConformanceManifest {
  /** Keyed by the registry union, so a new tool cannot compile without a per-root decision. */
  readonly tool: Readonly<Record<BuiltinToolName, RootStatuses>>;
  readonly 'agents-op': Readonly<Record<AgentsOp, RootStatuses>>;
  readonly 'memory-op': Readonly<Record<keyof typeof MEMORY, RootStatuses>>;
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

/** A subordinate has no peer transport: a workspace hire would let it escape its subtree. Locally every root agent gets PeerHub. */
const PEERS = {
  'cf-orchestrator': WIRED,
  'cf-subordinate': { absent: 'a subordinate has no peer transport; a workspace hire would escape its subtree' },
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

  'agents-op': {
    // A swarm needs only a model and a workspace, so it has no deps group to under-wire.
    swarm: EVERYWHERE,
    hire: TEAM_RECURSES,
    assign: TEAM_RECURSES,
    hireWorkspace: PEERS,
    message: TEAM_RECURSES,
    reply: PEERS,
    list: TEAM_RECURSES,
    dismiss: TEAM_RECURSES,
  },

  'memory-op': {
    remember: EVERYWHERE,
    recall: EVERYWHERE,
    forget: EVERYWHERE,
    note: EVERYWHERE,
    search: EVERYWHERE,
    searchConversations: EVERYWHERE,
    readConversation: EVERYWHERE,
    listConversations: EVERYWHERE,
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
  'agents-op': AGENTS_OPS,
  'memory-op': Object.keys(MEMORY),
  producer: CONFORMANCE_PRODUCERS,
} satisfies Partial<Record<ConformancePlane, readonly string[]>>;
