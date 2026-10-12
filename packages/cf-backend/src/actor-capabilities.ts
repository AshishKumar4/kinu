/**
 * Every agent's turn surface (design v2 §2, §9), from one factory (`OrchestratorAgent.actorSurface`): the workspace
 * agent's, a hire's, a head's, a swarm node's and a background run's alike. What the turn reaches is core's one decision
 * (`surfaceReach`); this is the shape the factory hands its turn's holder (`AgentTurns`).
 */
import { asSchema, type ToolSet } from 'ai';
import {
  argumentDigest, hasPlanPermission, projectJsonValue, toolDescription,
  type AgentToolDescriptor, type ArtifactOverrides, type DynamicReads, type ExecutionKey, type ExecutionLane, type HeadCapture, type OperationProfile,
  type ProfileAuthorityInputs, type ReportDeps, type ResolvedTurnProfile, type RunTurnSources, type SubordinateReportLedger,
  type TrialTurn, type TurnAssemblySources, type TurnLedgers, type TurnReach, type TurnSurface,
} from '@kinu.run/core';

/** The tools a turn reaches whose effects commit in the agent's own store (its plans, its questions): its isolate
 *  builds and runs them, so the workspace says only which it reaches. */
export type OwnerLane = Pick<TurnReach, 'askOwner' | 'submitPlan' | 'replyToComment'>;

/** Where a turn is assembled from, read here; its tools' names and its eval's namespaces are the surface's own. */
export type SurfaceSources = RunTurnSources & Pick<TurnAssemblySources, 'wiredToolNames' | 'codemodeCapabilities'>;

/** A head's or a swarm node's run, as its seat in this workspace hands it over: its tools, already receipted, the
 *  sources it assembles from and the capture its calls record into. */
export interface RunSurface {
  readonly tools: ToolSet;
  readonly sources: RunTurnSources;
  readonly capture: HeadCapture;
}

/** What one turn's surface is built for. */
export interface SurfaceTurn {
  readonly key: ExecutionKey;
  readonly lane: ExecutionLane;
  /** The words that opened it; empty for a turn read again. */
  readonly text: string;
  readonly run?: RunSurface;
}

/** What an agent's tools are built under: the execution they claim in, the ledgers they account into, the external
 *  tools its eval reaches, the operation they run under, and its hirer's report where its lane carries one. */
export interface ToolScope {
  readonly execution: () => Pick<ExecutionKey, 'turnId' | 'runId'>;
  readonly ledgers: TurnLedgers;
  readonly external: () => ToolSet;
  readonly profile: () => OperationProfile | null;
  readonly report?: ReportDeps;
}

/** The turn an agent's sources are read for: the surface it runs under, its resolution, its evolved text and the tools
 *  its MCP budget is measured against. */
export interface SourcesTurn {
  readonly surface: TurnSurface;
  readonly resolved: ResolvedSurface;
  readonly artifacts: ArtifactOverrides;
  readonly tools: ToolSet;
}

export interface ResolvedSurface {
  readonly profile: ResolvedTurnProfile;
  readonly inputs: ProfileAuthorityInputs;
}

export interface ActorSurface {
  /** Its execution, its ledgers, the operation its tools run under and the external tools its eval reaches. */
  readonly surface: TurnSurface;
  /** The resolution its tools were built under, until its isolate binds the final one. */
  readonly resolved: ResolvedSurface;
  readonly tools: ToolSet;
  /** Its tools as a retry of its job runs them: never handed to the background. */
  readonly raw: ToolSet;
  readonly sources: SurfaceSources;
  /** Its dynamic block's reads, held for the agent across its turns. */
  readonly reads: DynamicReads;
  readonly ownerLane: OwnerLane;
  readonly capture: HeadCapture;
  /** What the turn has told its hirer by now. */
  readonly reports: SubordinateReportLedger;
  /** Whether its turns are reviewed by an advisor. */
  readonly reviewsTurns: boolean;
  /** The workspace agent's live trial arm, when its fresh turn draws one. */
  readonly trial?: TrialTurn;
  /** What its isolate is told of its tools, and their digest: it is told them again only when the digest moves. */
  readonly descriptors: readonly AgentToolDescriptor[];
  readonly digest: string;
  /** The profile its isolate assembled on: its tools run under it, and its eval reaches what that profile allows. */
  bind(profile: ResolvedTurnProfile): void;
}

export async function describeTools(tools: ToolSet): Promise<{ readonly descriptors: AgentToolDescriptor[]; readonly digest: string }> {
  const descriptors = await Promise.all(Object.entries(tools).map(async ([name, tool]) => ({
    name,
    description: toolDescription(tool) ?? '',
    inputSchema: await asSchema(tool.inputSchema).jsonSchema,
    planAllowed: hasPlanPermission(tool),
  })));

  return { descriptors, digest: argumentDigest(projectJsonValue({ value: descriptors })) };
}
