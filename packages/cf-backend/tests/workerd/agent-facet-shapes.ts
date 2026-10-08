export interface AgentFacetAnswer {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A running job's probe latencies, quiet and with CPU-bound invocations queued on its object. */
export interface ProbeContention {
  readonly quiet: readonly number[];
  readonly loaded: readonly number[];
  /** From the load's start to its last invocation's answer. */
  readonly loadedMs: number;
  /** One queued invocation's CPU, measured alone. */
  readonly burnMs: number;
}

export interface OnePlaneObservation {
  readonly home: string;
  /** The agent's `pwd; id -u` from its own isolate. */
  readonly agentShell: AgentFacetAnswer;
  /** What the workspace's own view reads back of the file the agent wrote. */
  readonly mainRead: string | null;
  readonly mainCat: AgentFacetAnswer;
  /** The agent's isolate and the workspace object's are two isolates. */
  readonly sameIsolate: boolean;
}

/** What an entrypoint relaying a workspace answer hands the platform, read in the relay's own isolate. */
export interface RelayedAnswer<T> {
  readonly answer: T;
  readonly carriesDisposer: boolean;
}

export interface AgentFacetClaim {
  readonly actorId: string;
  readonly turnId: string;
  readonly outcome: string | null;
  readonly programKind: string;
}

export interface SwarmFacetObservation {
  readonly actorId: string;
  readonly home: string;
  readonly sameIsolate: boolean;
  readonly workspaceClaims: number;
  readonly claims: readonly AgentFacetClaim[];
  readonly retired: boolean;
  readonly summary: string;
  readonly candidate: string;
  readonly reportedItself: boolean;
}

/** A swarm node's `eval` over a tool main crafted, before and after main's store retires it by score. */
export interface NodeJobObservation {
  readonly actorId: string;
  readonly status: string;
  readonly summary: string;
}

export interface CraftedFromNodeObservation {
  readonly mainActorId: string;
  readonly nodeActorId: string;
  readonly called: string;
  readonly retired: string;
}
